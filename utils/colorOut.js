import { debug } from "../config.js"
import { getLogDateTime } from "./time.js"

function basePrint(color, msg) {
  console.log(`${color}%s %s\x1B[0m`, `[${getLogDateTime(new Date())}]`, msg)
}

function printRed(msg) {
  basePrint("\x1B[31m", msg)
}

function printGreen(msg) {
  basePrint("\x1B[32m", msg)
}

function printYellow(msg) {
  basePrint("\x1B[33m", msg)
}

function printBlue(msg) {
  basePrint("\x1B[34m", msg)
}

function printMagenta(msg) {
  basePrint("\x1B[35m", msg)
}

function printGrey(msg) {
  basePrint("\x1B[2m", msg)
}
function printDebug(obj) {
  if (debug) {
    console.dir(obj, { depth: null })
  }
}

export {
  printGreen, printBlue, printRed, printYellow, printMagenta, printGrey, printDebug
}
