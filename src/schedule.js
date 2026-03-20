import { chromium } from "playwright"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
  deleteLastMessage,
  useSchedule,
} from "./helpers.js"
import {
  GROUP,
  hours,
  PowerState,
  SHUTDOWNS_DATA_MATCHER,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
  HOURLY_INTERVAL,
} from "./constants.js"

let sendNotificationRetries = 0
let getShutdownsDataRetries = 0

const regionNames = {
  k: "Київ",
  kr: "Київська обл.",
  o: "Одеська обл.",
  d: "Донецька обл.",
  dn: "Дніпропетровська обл.",
}

function getGroupLabel() {
  if (process.env.GROUP_LABEL) return process.env.GROUP_LABEL

  const region = String(process.env.REGION).toLowerCase()
  const regionName = regionNames[region] || region.toUpperCase()
  return `${regionName} · ${GROUP}`
}

function periodDuration(begin, end) {
  const [bh, bm] = begin.split(":").map(Number)
  const [eh, em] = end.split(":").map(Number)
  const mins = eh * 60 + em - (bh * 60 + bm)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h} год ${m} хв` : `${h} год`
}

const getShutdownsData = async () => {
  console.log("🌀 Getting shutdowns data...")

  const browser = await chromium.launch({ headless: true })
  const browserPage = await browser.newPage()

  try {
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error("not found")
    }

    const data = JSON.parse(match[1])
    console.log("✅ Getting shutdowns data finished.")
    return data
  } catch (error) {
    console.error(`❌ Getting shutdowns data failed: ${error.message}.`)

    if (getShutdownsDataRetries < RETRIES_MAX_COUNT) {
      console.log("🌀 Try getting shutdowns data again...")
      getShutdownsDataRetries++
      await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
      return await getShutdownsData()
    }
  } finally {
    await browser.close()
  }
}

function generateSchedule({ data, today }) {
  console.log("🌀 Generating schedule...")

  try {
    const hoursStates = data?.[today]?.[GROUP]
    const [schedule, setSchedule] = useSchedule([])

    hours.forEach((hour) => {
      const state = hoursStates[hour + 1]

      switch (state) {
        case PowerState.ON:
          setSchedule(createPeriod({ hour, power: true }))
          break

        case PowerState.OFF:
          setSchedule(createPeriod({ hour, power: false }))
          break

        case PowerState.HALF_ON:
          setSchedule(createPeriod({ hour, endMin: 30, power: true }))
          setSchedule(createPeriod({ hour, startMin: 30, power: false }))
          break

        case PowerState.HALF_OFF:
          setSchedule(createPeriod({ hour, endMin: 30, power: false }))
          setSchedule(createPeriod({ hour, startMin: 30, power: true }))
          break
      }
    })

    console.log("✅ Generating schedule finished.")

    return schedule
  } catch (error) {
    throw Error(`❌ Generating schedule failed: ${error.message}.`)
  }
}

function computeStats(schedule) {
  let offMinutes = 0
  let onMinutes = 0

  schedule.forEach(({ begin, end, power }) => {
    const [bh, bm] = begin.split(":").map(Number)
    const [eh, em] = end.split(":").map(Number)
    const mins = eh * 60 + em - (bh * 60 + bm)
    if (power) onMinutes += mins
    else offMinutes += mins
  })

  const fmt = (m) => {
    const h = Math.floor(m / 60)
    const min = m % 60
    return min > 0 ? `${h} год ${min} хв` : `${h} год`
  }

  return {
    offStr: fmt(offMinutes),
    onStr: fmt(onMinutes),
    offMinutes,
    onMinutes,
  }
}

function generateMessage(schedule = [], apiUpdate, checkedAt) {
  console.log("🌀 Generating message...")

  const groupLabel = getGroupLabel()
  const hasShutdowns = schedule.some(({ power }) => !power)

  hasShutdowns
    ? console.log("🪫 Power shutdowns detected!")
    : console.log("🔋 No power shutdowns!")

  const { offStr, onStr, offMinutes } = computeStats(schedule)

  // Хронологічний список — всі блоки з тривалістю
  const periodLines = schedule
    .map(({ begin, end, power }) => {
      const dur = periodDuration(begin, end)
      return power
        ? `🔋 <code>${begin} – ${end}</code>  ${dur}`
        : `🪫 <code>${begin} – ${end}</code>  ${dur}`
    })
    .join("\n")

  const statsLine =
    offMinutes > 0
      ? `🕯 Без світла: <b>${offStr}</b>  |  💡 Зі світлом: <b>${onStr}</b>`
      : `💡 Зі світлом: <b>24 год</b>`

  return [
    `⚡️ <b>Графік відключень на сьогодні:</b>`,
    groupLabel,
    ``,
    statsLine,
    ...(hasShutdowns ? [``, periodLines] : []),
    ``,
    `📡 Дані DTEK: <i>${apiUpdate}</i>`,
    `🕐 Перевірено: <i>${checkedAt}</i>`,
  ].join("\n")
}

function shouldUpdate(lastMessage, apiUpdate) {
  if (!lastMessage?.message_id) {
    return { doUpdate: true, isUrgent: false, reason: "no_message" }
  }

  if (lastMessage.apiUpdate !== apiUpdate) {
    return { doUpdate: true, isUrgent: true, reason: "api_changed" }
  }

  const elapsed = Date.now() - (lastMessage.lastEditedAt || 0)
  if (elapsed >= HOURLY_INTERVAL) {
    return { doUpdate: true, isUrgent: false, reason: "hourly" }
  }

  const minutesLeft = Math.ceil((HOURLY_INTERVAL - elapsed) / 60000)
  return { doUpdate: false, isUrgent: false, reason: "skip", minutesLeft }
}

async function sendNotification(message, apiUpdate) {
  if (!TELEGRAM_BOT_TOKEN) throw Error("❌ Missing telegram bot token.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  const lastMessage = loadLastMessage() || {}
  const { doUpdate, isUrgent, reason, minutesLeft } = shouldUpdate(lastMessage, apiUpdate)

  if (!doUpdate) {
    console.log(`ℹ️ Skip: наступне оновлення через ~${minutesLeft} хв.`)
    return
  }

  const actionLabel = isUrgent
    ? "🚨 ТЕРМІНОВО (API змінився)"
    : reason === "no_message"
      ? "нове повідомлення"
      : "планове оновлення (1 год)"

  console.log(`🌀 Надсилання: ${actionLabel}...`)

  try {
    const isEdit = Boolean(lastMessage.message_id)
    const endpoint = isEdit ? "editMessageText" : "sendMessage"

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(isEdit ? {} : { disable_notification: isUrgent ? false : checkIsNight() }),
          ...(isEdit ? { message_id: lastMessage.message_id } : {}),
        }),
      }
    )

    const result = await response.json()

    if (!result.ok) {
      // Повідомлення могли видалити вручну — відправляємо нове
      if (result.error_code === 400) {
        console.log("⚠️ Повідомлення не знайдено, відправляємо нове...")
        deleteLastMessage()
        sendNotificationRetries = 0
        return await sendNotification(message, apiUpdate)
      }
      throw new Error(result.description)
    }

    saveLastMessage({
      ...result.result,
      text: message,
      apiUpdate,
      lastEditedAt: Date.now(),
    })

    console.log(`🟢 Повідомлення ${isEdit ? "відредаговано" : "надіслано"}.`)
  } catch (error) {
    console.log("🔴 Помилка надсилання:", error.message)
    deleteLastMessage()

    if (sendNotificationRetries < RETRIES_MAX_COUNT) {
      console.log("🌀 Повторна спроба...")
      sendNotificationRetries++
      await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
      await sendNotification(message, apiUpdate)
    }
  }
}

async function run() {
  const apiData = await getShutdownsData()
  const schedule = generateSchedule(apiData)
  const checkedAt = getCurrentTime()
  const message = generateMessage(schedule, apiData.update, checkedAt)

  await sendNotification(message, apiData.update)
}

run().catch((error) => console.error(error.message))
