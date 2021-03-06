// @flow
const util = require(`util`)
const { stripIndent } = require(`common-tags`)
const chalk = require(`chalk`)
const { trackError } = require(`gatsby-telemetry`)
const tracer = require(`opentracing`).globalTracer()
const { getErrorFormatter } = require(`./errors`)
const reporterInstance = require(`./reporters`)
const constructError = require(`../structured-errors/construct-error`)
const errorFormatter = getErrorFormatter()
const { trackCli } = require(`gatsby-telemetry`)
const convertHrtime = require(`convert-hrtime`)

import type { ActivityTracker, ActivityArgs, Reporter } from "./types"

/**
 * Reporter module.
 * @module reporter
 */
const reporter: Reporter = {
  /**
   * Strip initial indentation template function.
   */
  stripIndent,
  format: chalk,
  /**
   * Toggle verbosity.
   * @param {boolean} [isVerbose=true]
   */
  setVerbose: (isVerbose = true) => reporterInstance.setVerbose(isVerbose),
  /**
   * Turn off colors in error output.
   * @param {boolean} [isNoColor=false]
   */
  setNoColor(isNoColor = false) {
    reporterInstance.setColors(isNoColor)

    if (isNoColor) {
      errorFormatter.withoutColors()
    }
  },
  /**
   * Log arguments and exit process with status 1.
   * @param {*} args
   */
  panic(...args) {
    const error = this.error(...args)
    trackError(`GENERAL_PANIC`, { error })
    process.exit(1)
  },

  panicOnBuild(...args) {
    const error = this.error(...args)
    trackError(`BUILD_PANIC`, { error })
    if (process.env.gatsby_executing_command === `build`) {
      process.exit(1)
    }
  },

  error(errorMeta, error) {
    let details = {}
    // Many paths to retain backcompat :scream:
    if (arguments.length === 2) {
      if (Array.isArray(error)) {
        return error.map(errorItem => this.error(errorMeta, errorItem))
      }
      details.error = error
      details.context = {
        sourceMessage: errorMeta + ` ` + error.message,
      }
    } else if (arguments.length === 1 && errorMeta instanceof Error) {
      details.error = errorMeta
      details.context = {
        sourceMessage: errorMeta.message,
      }
    } else if (arguments.length === 1 && Array.isArray(errorMeta)) {
      // when we get an array of messages, call this function once for each error
      return errorMeta.map(errorItem => this.error(errorItem))
    } else if (arguments.length === 1 && typeof errorMeta === `object`) {
      details = Object.assign({}, errorMeta)
    } else if (arguments.length === 1 && typeof errorMeta === `string`) {
      details.context = {
        sourceMessage: errorMeta,
      }
    }

    const structuredError = constructError({ details })
    if (structuredError) reporterInstance.error(structuredError)

    // TODO: remove this once Error component can render this info
    // log formatted stacktrace
    if (structuredError.error) {
      this.log(errorFormatter.render(structuredError.error))
    }
    return structuredError
  },

  /**
   * Set prefix on uptime.
   * @param {string} prefix - A string to prefix uptime with.
   */
  uptime(prefix) {
    this.verbose(`${prefix}: ${(process.uptime() * 1000).toFixed(3)}ms`)
  },

  success: reporterInstance.success,
  verbose: reporterInstance.verbose,
  info: reporterInstance.info,
  warn: reporterInstance.warn,
  log: reporterInstance.log,

  /**
   * Time an activity.
   * @param {string} name - Name of activity.
   * @param {ActivityArgs} activityArgs - optional object with tracer parentSpan
   * @returns {ActivityTracker} The activity tracker.
   */
  activityTimer(
    name: string,
    activityArgs: ActivityArgs = {}
  ): ActivityTracker {
    const { parentSpan } = activityArgs
    const spanArgs = parentSpan ? { childOf: parentSpan } : {}
    const span = tracer.startSpan(name, spanArgs)
    let startTime = 0

    const activity = reporterInstance.createActivity({
      type: `spinner`,
      id: name,
      status: ``,
    })

    return {
      start() {
        startTime = process.hrtime()
        activity.update({
          startTime: startTime,
        })
      },
      setStatus(status) {
        activity.update({
          status: status,
        })
      },
      end() {
        trackCli(`ACTIVITY_DURATION`, {
          name: name,
          duration: Math.round(
            convertHrtime(process.hrtime(startTime))[`milliseconds`]
          ),
        })

        span.finish()
        activity.done()
      },
      span,
    }
  },

  /**
   * Create a progress bar for an activity
   * @param {string} name - Name of activity.
   * @param {number} total - Total items to be processed.
   * @param {number} start - Start count to show.
   * @param {ActivityArgs} activityArgs - optional object with tracer parentSpan
   * @returns {ActivityTracker} The activity tracker.
   */
  createProgress(
    name: string,
    total,
    start = 0,
    activityArgs: ActivityArgs = {}
  ): ActivityTracker {
    const { parentSpan } = activityArgs
    const spanArgs = parentSpan ? { childOf: parentSpan } : {}
    const span = tracer.startSpan(name, spanArgs)

    let hasStarted = false
    let current = start
    const activity = reporterInstance.createActivity({
      type: `progress`,
      id: name,
      current,
      total,
    })

    return {
      start() {
        if (hasStarted) {
          return
        }

        hasStarted = true
        activity.update({
          startTime: process.hrtime(),
        })
      },
      setStatus(status) {
        activity.update({
          status: status,
        })
      },
      tick() {
        activity.update({
          current: ++current,
        })
      },
      done() {
        span.finish()
        activity.done()
      },
      set total(value) {
        total = value
        activity.update({
          total: value,
        })
      },
      span,
    }
  },
  // Make private as we'll probably remove this in a future refactor.
  _setStage(stage) {
    if (reporterInstance.setStage) {
      reporterInstance.setStage(stage)
    }
  },
}

console.log = (...args) => reporter.log(util.format(...args))
console.warn = (...args) => reporter.log(util.format(...args))
console.info = (...args) => reporter.log(util.format(...args))
console.error = (...args) => reporter.log(util.format(...args))

module.exports = reporter
