/* jshint node: true,esversion: 9, -W014, -W033 */
/* eslint-disable new-cap */
'use strict'

module.exports = class deviceCloudOutletSingle {
  constructor (platform, accessory) {
    // Set up variables from the platform
    this.funcs = platform.funcs
    this.hapChar = platform.api.hap.Characteristic
    this.hapErr = platform.api.hap.HapStatusError
    this.hapServ = platform.api.hap.Service
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform

    // Set up variables from the accessory
    this.accessory = accessory
    this.channel = accessory.context.channel
    this.enableLogging = accessory.context.enableLogging
    this.enableDebugLogging = accessory.context.enableDebugLogging
    this.name = accessory.displayName

    // If the accessory has a switch service then remove it
    if (this.accessory.getService(this.hapServ.Switch)) {
      this.accessory.removeService(this.accessory.getService(this.hapServ.Switch))
    }

    // Add the outlet service if it doesn't already exist
    this.service =
      this.accessory.getService(this.hapServ.Outlet) ||
      this.accessory.addService(this.hapServ.Outlet)

    // Add the set handler to the outlet on/off characteristic
    this.service
      .getCharacteristic(this.hapChar.On)
      .onSet(async value => await this.internalStateUpdate(value))

    // Always request a device update on startup, then enable polling if user enabled
    this.requestDeviceUpdate()
    if (this.platform.config.cloudRefreshRate > 0) {
      this.refreshinterval = setInterval(
        () => this.requestDeviceUpdate(),
        this.platform.config.cloudRefreshRate * 1000
      )
    }

    // Stop the intervals and close mqtt connection on Homebridge shutdown
    platform.api.on('shutdown', () => {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval)
      }
      if (this.accessory.mqtt) {
        this.accessory.mqtt.disconnect()
      }
    })
  }

  async internalStateUpdate (value) {
    try {
      // Don't continue if the state is the same as before
      if (value === this.cacheState) {
        return
      }

      // Send the command
      await this.accessory.mqtt.controlToggleX(0, value)

      // Update the cache and log if appropriate
      this.cacheState = value
      if (this.enableLogging) {
        this.log('[%s] current state [%s].', this.name, this.cacheState ? 'on' : 'off')
      }
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] sending update failed as %s.', this.name, eText)
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.On, this.cacheState)
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async requestDeviceUpdate () {
    try {
      // Send a request for a status update for the device
      const result = await this.accessory.mqtt.getSystemAllData()

      // If debug enabled then log the response
      if (this.enableDebugLogging) {
        this.log('[%s] incoming poll message:\n%s', this.name, JSON.stringify(result.payload))
      }

      // Check the data is in a format which contains the value we need
      if (
        !result.payload ||
        !result.payload.all ||
        !result.payload.all.digest ||
        !result.payload.all.digest.togglex ||
        !Array.isArray(result.payload.all.digest.togglex) ||
        !result.payload.all.digest.togglex[0]
      ) {
        throw new Error('data in invalid format')
      }

      // Read the current state
      const newState = result.payload.all.digest.togglex[0].onoff === 1

      // Don't continue if the state is the same as before
      if (newState === this.cacheState) {
        return
      }

      // Update the HomeKit characteristics
      this.service.updateCharacteristic(this.hapChar.On, newState)

      // Update the cache and log the change if the user has logging turned on
      this.cacheState = newState
      if (this.enableLogging) {
        this.log('[%s] current state [%s].', this.name, newState ? 'on' : 'off')
      }
    } catch (err) {
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] failed to refresh status as %s.', this.name, eText)
    }
  }

  externalUpdate (namespace, payload) {
    try {
      // If debug enabled then log the response
      if (this.enableDebugLogging) {
        this.log(
          '[%s] incoming mqtt message [%s]:\n%s',
          this.name,
          namespace,
          JSON.stringify(payload)
        )
      }

      // Check the data is in a format which contains the value we need
      if (
        namespace !== 'Appliance.Control.ToggleX' ||
        !payload.togglex ||
        !Array.isArray(payload.togglex) ||
        !payload.togglex[0]
      ) {
        throw new Error('data in invalid format')
      }

      // Read the current state
      const newState = payload.togglex[0].onoff

      // Don't continue if the state is the same as before
      if (newState === this.cacheState) {
        return
      }

      // Update the HomeKit characteristics
      this.service.updateCharacteristic(this.hapChar.On, newState)

      // Update the cache and log the change if the user has logging turned on
      this.cacheState = newState
      if (this.enableLogging) {
        this.log('[%s] current state [%s].', this.name, newState ? 'on' : 'off')
      }
    } catch (err) {
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] failed to refresh status as %s.', this.name, eText)
    }
  }
}