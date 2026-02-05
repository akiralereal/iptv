
function getDateString(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
}

function getTimeString(date) {
  return `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`
}

function getDateTimeString(date) {
  return `${getDateString(date)}${getTimeString(date)}`
}

function getDateTimeStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ` +
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

function getLogDateTime(date) {
  return `${getDateTimeStr(date)}:${String(date.getMilliseconds()).padStart(3, "0")}`
}

export { getDateString, getTimeString, getDateTimeString, getDateTimeStr, getLogDateTime }
