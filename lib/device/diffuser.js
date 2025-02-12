import PQueue from 'p-queue'; // eslint-disable-line import/no-unresolved
import { TimeoutError } from 'p-timeout';
import mqttClient from '../connection/mqtt.js';
import {
  hk2mrRGB,
  hs2rgb,
  mr2hkRGB,
  rgb2hs,
} from '../utils/colour.js';
import platformConsts from '../utils/constants.js';
import {
  generateRandomString,
  hasProperty,
  parseError,
  sleep,
} from '../utils/functions.js';
import platformLang from '../utils/lang-en.js';

export default class {
  constructor(platform, accessory) {
    // Set up variables from the platform
    this.cusChar = platform.cusChar;
    this.hapChar = platform.api.hap.Characteristic;
    this.hapErr = platform.api.hap.HapStatusError;
    this.hapServ = platform.api.hap.Service;
    this.log = platform.log;
    this.platform = platform;

    // Set up variables from the accessory
    this.accessory = accessory;
    this.brightnessStep = this.accessory.context.options.brightnessStep || platformConsts.defaultValues.brightnessStep;
    this.brightnessStep = Math.min(this.brightnessStep, 100);
    this.enableLogging = accessory.context.enableLogging;
    this.enableDebugLogging = accessory.context.enableDebugLogging;
    this.name = accessory.displayName;
    const cloudRefreshRate = hasProperty(platform.config, 'cloudRefreshRate')
      ? platform.config.cloudRefreshRate
      : platformConsts.defaultValues.cloudRefreshRate;
    const localRefreshRate = hasProperty(platform.config, 'refreshRate')
      ? platform.config.refreshRate
      : platformConsts.defaultValues.refreshRate;
    this.pollInterval = accessory.context.connection === 'local'
      ? localRefreshRate
      : cloudRefreshRate;
    this.hk2mr = (speed) => {
      if (speed === 0) {
        return 2;
      } if (speed <= 75) {
        return 0;
      }
      return 1;
    };
    this.hk2Label = (speed) => {
      if (speed === 0) {
        return 'off';
      } if (speed <= 75) {
        return 'mild';
      }
      return 'full';
    };
    this.mr2hk = (speed) => {
      if (speed === 0) {
        return 50;
      } if (speed === 1) {
        return 100;
      }
      return 0;
    };

    // Add the diffuser (fan) service if it doesn't already exist
    this.fanService = this.accessory.getService('Diffuser')
      || this.accessory.addService(this.hapServ.Fan, 'Diffuser', 'diffuser');

    // Add the lightbulb service if it doesn't already exist
    this.lightService = this.accessory.getService('Light')
      || this.accessory.addService(this.hapServ.Lightbulb, 'Light', 'light');

    // Add the set handler to the diffuser (fan) on/off service
    this.fanService
      .getCharacteristic(this.hapChar.On)
      .onSet(async (value) => this.internalFanStateUpdate(value));
    this.cacheFanState = this.fanService.getCharacteristic(this.hapChar.On).value;

    this.fanService
      .getCharacteristic(this.hapChar.RotationSpeed)
      .setProps({
        minStep: 50,
        validValues: [0, 50, 100],
      })
      .onSet(async (value) => this.internalFanSpeedUpdate(value));
    this.cacheFanSpeed = this.hk2mr(
      this.fanService.getCharacteristic(this.hapChar.RotationSpeed).value,
    );

    // Add the set handler to the lightbulb on/off characteristic
    this.lightService
      .getCharacteristic(this.hapChar.On)
      .onSet(async (value) => this.internalLightStateUpdate(value));
    this.cacheLightState = this.lightService.getCharacteristic(this.hapChar.On).value;

    // Add the set handler to the lightbulb brightness
    this.lightService
      .getCharacteristic(this.hapChar.Brightness)
      .setProps({ minStep: this.brightnessStep })
      .onSet(async (value) => this.internalLightBrightnessUpdate(value));
    this.cacheLightBright = this.lightService.getCharacteristic(this.hapChar.Brightness).value;

    // Add the set handler to the lightbulb hue characteristic
    this.lightService
      .getCharacteristic(this.hapChar.Hue)
      .onSet(async (value) => this.internalLightColourUpdate(value));
    this.cacheLightHue = this.lightService.getCharacteristic(this.hapChar.Hue).value;
    this.cacheLightSat = this.lightService.getCharacteristic(this.hapChar.Saturation).value;

    // Add the set handler to the diffuser (fan) custom colour mode characteristic
    if (!this.lightService.testCharacteristic(this.cusChar.DiffColourMode)) {
      this.lightService.addCharacteristic(this.cusChar.DiffColourMode);
    }
    this.lightService
      .getCharacteristic(this.cusChar.DiffColourMode)
      .onSet(async (value) => this.internalLightModeUpdate(value, 'colour'));
    if (this.lightService.getCharacteristic(this.cusChar.DiffColourMode).value) {
      this.cacheLightMode = 1;
    }

    // Add the set handler to the diffuser (fan) custom rainbow mode characteristic
    if (!this.lightService.testCharacteristic(this.cusChar.DiffRainbowMode)) {
      this.lightService.addCharacteristic(this.cusChar.DiffRainbowMode);
    }
    this.lightService
      .getCharacteristic(this.cusChar.DiffRainbowMode)
      .onSet(async (value) => this.internalLightModeUpdate(value, 'rainbow'));
    if (this.lightService.getCharacteristic(this.cusChar.DiffRainbowMode).value) {
      this.cacheLightMode = 0;
    }

    // Add the set handler to the diffuser (fan) custom temperature mode characteristic
    if (!this.lightService.testCharacteristic(this.cusChar.DiffTemperatureMode)) {
      this.lightService.addCharacteristic(this.cusChar.DiffTemperatureMode);
    }
    this.lightService
      .getCharacteristic(this.cusChar.DiffTemperatureMode)
      .onSet(async (value) => this.internalLightModeUpdate(value, 'temperature'));
    if (this.lightService.getCharacteristic(this.cusChar.DiffTemperatureMode).value) {
      this.cacheLightMode = 2;
    }

    // Create the queue used for sending device requests
    this.updateInProgress = false;
    this.queue = new PQueue({
      concurrency: 1,
      interval: 250,
      intervalCap: 1,
      timeout: 10000,
      throwOnTimeout: true,
    });
    this.queue.on('idle', () => {
      this.updateInProgress = false;
    });

    // Set up the mqtt client for cloud devices to send and receive device updates
    if (accessory.context.connection !== 'local') {
      this.accessory.mqtt = new mqttClient(platform, this.accessory);
      this.accessory.mqtt.connect();
    }

    // Always request a device update on startup, then start the interval for polling
    this.requestUpdate(true);
    this.accessory.refreshInterval = setInterval(
      () => this.requestUpdate(),
      this.pollInterval * 1000,
    );

    // Output the customised options to the log
    const normalLogging = this.enableLogging ? 'standard' : 'disable';
    const opts = JSON.stringify({
      brightnessStep: this.brightnessStep,
      connection: this.accessory.context.connection,
      logging: this.enableDebugLogging ? 'debug' : normalLogging,
    });
    this.log('[%s] %s %s.', this.name, platformLang.devInitOpts, opts);
  }

  async internalFanStateUpdate(value) {
    try {
      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // Don't continue if the state is the same as before
        if (value === this.cacheFanState) {
          return;
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Generate the payload and namespace
        const namespace = 'Appliance.Control.Diffuser.Spray';
        const payload = {
          type: 'mod100',
          spray: [
            {
              mode: value ? this.cacheFanSpeed : 2,
              channel: 0,
            },
          ],
        };

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload,
        });

        // Update the cache and log the update has been successful
        this.cacheFanState = value;
        if (this.enableLogging) {
          this.log('[%s] current diffuser state [%s].', this.name, value ? 'on' : 'off');
        }
      });
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = err instanceof TimeoutError ? platformLang.timeout : parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.sendFailed, eText);
      setTimeout(() => {
        this.fanService.updateCharacteristic(this.hapChar.On, this.cacheFanState);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalFanSpeedUpdate(value) {
    try {
      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // Some homekit apps might not support the valid values of 0, 50 and 100
        if (value === 0) {
          value = 0;
        } else if (value <= 75) {
          value = 50;
        } else {
          value = 100;
        }

        // Don't continue if the state is the same as before
        const mrVal = this.hk2mr(value);
        if (mrVal === this.cacheFanSpeed) {
          return;
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Generate the payload and namespace
        const namespace = 'Appliance.Control.Diffuser.Spray';
        const payload = {
          type: 'mod100',
          spray: [
            {
              mode: mrVal,
              channel: 0,
            },
          ],
        };

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload,
        });

        // If using the slider to turn off then set the rotation speed back to original value
        // This stops homekit turning back to 100% if using the icon after turned off
        if (value === 0) {
          // Update the rotation speed back to the previous value (with the fan still off)
          setTimeout(() => {
            this.fanService.updateCharacteristic(
              this.hapChar.RotationSpeed,
              this.mr2hk(this.cacheFanSpeed),
            );
          }, 2000);
        } else {
          // Update the cache and log the update has been successful
          this.cacheFanSpeed = mrVal;
          if (this.enableLogging) {
            this.log('[%s] current diffuser spray [%s].', this.name, this.hk2Label(value));
          }
        }
      });
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = err instanceof TimeoutError ? platformLang.timeout : parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.sendFailed, eText);
      setTimeout(() => {
        this.fanService.updateCharacteristic(
          this.hapChar.RotationSpeed,
          this.mr2hk(this.cacheFanSpeed),
        );
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalLightStateUpdate(value) {
    try {
      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // Don't continue if the state is the same as before
        if (value === this.cacheLightState) {
          return;
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Generate the payload and namespace
        const namespace = 'Appliance.Control.Diffuser.Light';
        const payload = {
          type: 'mod100',
          light: [
            {
              onoff: value ? 1 : 0,
              channel: 0,
            },
          ],
        };

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload,
        });

        // Update the cache and log the update has been successful
        this.cacheLightState = value;
        if (this.enableLogging) {
          this.log('[%s] current light state [%s].', this.name, value ? 'on' : 'off');
        }
      });
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = err instanceof TimeoutError ? platformLang.timeout : parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.sendFailed, eText);
      setTimeout(() => {
        this.lightService.updateCharacteristic(this.hapChar.On, this.cacheLightState);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalLightBrightnessUpdate(value) {
    try {
      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // Don't continue if the state is the same as before
        if (this.cacheLightBright === value) {
          return;
        }

        // Avoid multiple changes in short space of time
        const updateKey = generateRandomString(5);
        this.updateKeyBright = updateKey;
        await sleep(300);
        if (updateKey !== this.updateKeyBright) {
          return;
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Generate the payload to send for the correct device model
        const namespace = 'Appliance.Control.Diffuser.Light';
        const payload = {
          type: 'mod100',
          light: [
            {
              luminance: value,
              channel: 0,
            },
          ],
        };

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload,
        });

        // Update the cache and log the update has been successful
        this.cacheLightBright = value;
        if (this.enableLogging) {
          this.log('[%s] current light brightness [%s%].', this.name, value);
        }
      });
    } catch (err) {
      const eText = parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.sendFailed, eText);
      setTimeout(() => {
        this.lightService.updateCharacteristic(this.hapChar.Brightness, this.cacheLightBright);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalLightColourUpdate(value) {
    try {
      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // Don't continue if the state is the same as before
        if (this.cacheLightHue === value) {
          return;
        }

        // Avoid multiple changes in short space of time
        const updateKey = generateRandomString(5);
        this.updateKeyColour = updateKey;
        await sleep(300);
        if (updateKey !== this.updateKeyColour) {
          return;
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Convert to RGB
        const saturation = this.lightService.getCharacteristic(this.hapChar.Saturation).value;
        const [r, g, b] = hs2rgb(value, saturation);

        // Generate the payload to send
        const namespace = 'Appliance.Control.Diffuser.Light';
        const payload = {
          type: 'mod100',
          light: [
            {
              rgb: hk2mrRGB(r, g, b),
              mode: 1,
              channel: 0,
            },
          ],
        };

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload,
        });

        // Update the cache and log the update has been successful
        this.cacheLightHue = value;
        this.cacheLightSat = this.lightService.getCharacteristic(this.hapChar.Saturation).value;
        if (this.enableLogging) {
          this.log(
            '[%s] current light hue/sat [%s, %s] rgb [%s, %s, %s].',
            this.name,
            this.cacheLightHue,
            this.cacheLightSat,
            r,
            g,
            b,
          );
        }
      });
    } catch (err) {
      const eText = parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.sendFailed, eText);
      setTimeout(() => {
        this.lightService.updateCharacteristic(this.hapChar.Hue, this.cacheLightHue);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async internalLightModeUpdate(value, mode) {
    try {
      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // Don't continue if we are turning off, can't leave a mode without selecting another
        if (!value) {
          return;
        }

        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Get the mode value from the mode selected
        let modeVal;
        switch (mode) {
          case 'colour':
            modeVal = 1;
            break;
          case 'rainbow':
            modeVal = 0;
            break;
          case 'temperature':
            modeVal = 2;
            break;
          default:
            // Should never happen
            return;
        }

        // Generate the payload and namespace
        const namespace = 'Appliance.Control.Diffuser.Light';
        const payload = {
          type: 'mod100',
          light: [
            {
              mode: modeVal,
              channel: 0,
            },
          ],
        };

        // Use the platform function to send the update to the device
        await this.platform.sendUpdate(this.accessory, {
          namespace,
          payload,
        });

        // Turn all the mode characteristics OFF, the needed one will turn ON at end of this func
        ['DiffColourMode', 'DiffRainbowMode', 'DiffTemperatureMode'].forEach((cusChar) => {
          this.lightService.updateCharacteristic(this.cusChar[cusChar], false);
        });

        // Update the cache and log the update has been successful
        this.cacheLightMode = modeVal;
        if (this.enableLogging) {
          this.log('[%s] current light mode [%s].', this.name, mode);
        }
      });
    } catch (err) {
      // Catch any errors whilst updating the device
      const eText = err instanceof TimeoutError ? platformLang.timeout : parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.sendFailed, eText);
      let charToError;
      switch (mode) {
        case 'colour':
          charToError = this.cusChar.DiffColourMode;
          break;
        case 'rainbow':
          charToError = this.cusChar.DiffRainbowMode;
          break;
        case 'temperature':
          charToError = this.cusChar.DiffTemperatureMode;
          break;
        default:
          // Should never happen
          return;
      }
      setTimeout(() => {
        this.lightService.updateCharacteristic(charToError, false);
      }, 2000);
      throw new this.hapErr(-70402);
    }
  }

  async requestUpdate(firstRun = false) {
    try {
      // Don't continue if an update is currently being sent to the device
      if (this.updateInProgress) {
        return;
      }

      // Add the request to the queue so updates are sent apart
      await this.queue.add(async () => {
        // This flag stops the plugin from requesting updates while pending on others
        this.updateInProgress = true;

        // Send the request
        const res = await this.platform.sendUpdate(this.accessory, {
          namespace: 'Appliance.System.All',
          payload: {},
        });

        // Log the received data
        if (this.enableDebugLogging) {
          this.log('[%s] %s: %s.', this.name, platformLang.incPoll, JSON.stringify(res.data));
        }

        // Check the response is in a useful format
        const data = res.data.payload;

        if (data.all) {
          if (data.all.digest && data.all.digest.diffuser) {
            this.applyUpdate(data.all.digest.diffuser);
          }

          // A flag to check if we need to update the accessory context
          let needsUpdate = false;

          // Get the mac address and hardware version of the device
          if (data.all.system) {
            // Mac address and hardware don't change regularly so only get on first poll
            if (firstRun && data.all.system.hardware) {
              this.accessory.context.macAddress = data.all.system.hardware.macAddress.toUpperCase();
              this.accessory.context.hardware = data.all.system.hardware.version;
            }

            // Get the ip address and firmware of the device
            if (data.all.system.firmware) {
              // Check for an IP change each and every time the device is polled
              if (this.accessory.context.ipAddress !== data.all.system.firmware.innerIp) {
                this.accessory.context.ipAddress = data.all.system.firmware.innerIp;
                needsUpdate = true;
              }

              // Firmware doesn't change regularly so only get on first poll
              if (firstRun) {
                this.accessory.context.firmware = data.all.system.firmware.version;
              }
            }
          }

          // Get the cloud online status of the device
          if (data.all.system.online) {
            const isOnline = data.all.system.online.status === 1;
            if (this.accessory.context.isOnline !== isOnline) {
              this.accessory.context.isOnline = isOnline;
              needsUpdate = true;
            }
          }

          // Update the accessory cache if anything has changed
          if (needsUpdate || firstRun) {
            this.platform.updateAccessory(this.accessory);
          }
        }
      });
    } catch (err) {
      const eText = err instanceof TimeoutError ? platformLang.timeout : parseError(err);
      if (this.enableDebugLogging) {
        this.log.warn('[%s] %s %s.', this.name, platformLang.reqFailed, eText);
      }

      // Set the homebridge-ui status of the device to offline if local and error is timeout
      if (
        (this.accessory.context.isOnline || firstRun)
        && ['EHOSTUNREACH', 'timed out'].some((el) => eText.includes(el))
      ) {
        this.accessory.context.isOnline = false;
        this.platform.updateAccessory(this.accessory);
      }
    }
  }

  receiveUpdate(params) {
    try {
      // Log the received data
      if (this.enableDebugLogging) {
        this.log('[%s] %s: %s.', this.name, platformLang.incMQTT, JSON.stringify(params));
      }

      // Check the response is in a useful format
      const data = params.payload;
      if (data.light || data.spray) {
        this.applyUpdate(data);
      }
    } catch (err) {
      const eText = parseError(err);
      this.log.warn('[%s] %s %s.', this.name, platformLang.refFailed, eText);
    }
  }

  applyUpdate(data) {
    // Update the diffuser (fan) service from the supplied data
    if (data.spray && data.spray[0] && hasProperty(data.spray[0], 'mode')) {
      const newSpeed = data.spray[0].mode;

      // Check against the cache and update HomeKit and the cache if needed
      if (this.cacheFanSpeed !== newSpeed) {
        this.cacheFanSpeed = newSpeed;
        if (this.cacheFanSpeed === 2) {
          // Looks like the spray has been turned off
          this.cacheFanState = false;
          this.fanService.updateCharacteristic(this.hapChar.On, false);
          if (this.enableLogging) {
            this.log('[%s] current diffuser state [off].', this.name);
          }
        } else {
          // Looks like the spray is now on (from OFF or a different mode)
          if (!this.cacheFanState) {
            // Looks like the spray has been turn ON from OFF
            this.cacheFanState = true;
            this.fanService.updateCharacteristic(this.hapChar.On, true);
            if (this.enableLogging) {
              this.log('[%s] current diffuser state [on].', this.name);
            }
          }
          const hkValue = this.mr2hk(this.cacheFanSpeed);
          this.fanService.updateCharacteristic(this.hapChar.RotationSpeed, hkValue);
          if (this.enableLogging) {
            this.log('[%s] current diffuser spray [%s].', this.name, this.hk2Label(hkValue));
          }
        }
      }
    }

    // Update the light from the supplied data
    if (data.light && data.light[0]) {
      if (hasProperty(data.light[0], 'onoff')) {
        const newState = data.light[0].onoff === 1;

        // Check against the cache and update HomeKit and the cache if needed
        if (this.cacheLightState !== newState) {
          this.lightService.updateCharacteristic(this.hapChar.On, newState);
          this.cacheLightState = newState;
          if (this.enableLogging) {
            this.log(
              '[%s] current light state [%s].',
              this.name,
              this.cacheLightState ? 'on' : 'off',
            );
          }
        }
      }
      if (hasProperty(data.light[0], 'luminance')) {
        const newBright = data.light[0].luminance;

        // Check against the cache and update HomeKit and the cache if needed
        if (this.cacheBright !== newBright) {
          this.lightService.updateCharacteristic(this.hapChar.Brightness, newBright);
          this.cacheLightBright = newBright;
          if (this.enableLogging) {
            this.log('[%s] current light brightness [%s%].', this.name, this.cacheLightBright);
          }
        }
      }
      if (data.light[0].mode === 0) {
        if (!this.cacheLightMode !== 0) {
          this.cacheLightMode = 0;
          ['DiffColourMode', 'DiffTemperatureMode'].forEach((cusChar) => {
            this.lightService.updateCharacteristic(this.cusChar[cusChar], false);
          });
          this.lightService.updateCharacteristic(this.cusChar.DiffRainbowMode, true);
          if (this.enableLogging) {
            this.log('[%s] current light mode [rainbow].', this.name);
          }
        }
      }
      if (data.light[0].mode === 1) {
        if (!this.cacheLightMode !== 1) {
          this.cacheLightMode = 1;
          ['DiffRainbowMode', 'DiffTemperatureMode'].forEach((cusChar) => {
            this.lightService.updateCharacteristic(this.cusChar[cusChar], false);
          });
          this.lightService.updateCharacteristic(this.cusChar.DiffColourMode, true);
          if (this.enableLogging) {
            this.log('[%s] current light mode [colour].', this.name);
          }
        }
        if (hasProperty(data.light[0], 'rgb')) {
          const [r, g, b] = mr2hkRGB(data.light[0].rgb);
          const [newHue, newSat] = rgb2hs(r, g, b);

          // Check against the cache and update HomeKit and the cache if needed
          if (this.cacheLightHue !== newHue || this.cacheLightSat !== newSat) {
            this.lightService.updateCharacteristic(this.hapChar.Hue, newHue);
            this.lightService.updateCharacteristic(this.hapChar.Saturation, newSat);
            this.cacheLightHue = newHue;
            this.cacheLightSat = newSat;
            if (this.enableLogging) {
              this.log(
                '[%s] current light hue/sat [%s, %s] rgb [%s, %s, %s].',
                this.name,
                this.cacheLightHue,
                this.cacheLightSat,
                r,
                g,
                b,
              );
            }
          }
        }
      }
      if (data.light[0].mode === 2) {
        if (!this.cacheLightMode !== 2) {
          this.cacheLightMode = 2;
          ['DiffColourMode', 'DiffRainbowMode'].forEach((cusChar) => {
            this.lightService.updateCharacteristic(this.cusChar[cusChar], false);
          });
          this.lightService.updateCharacteristic(this.cusChar.DiffTemperatureMode, true);
          if (this.enableLogging) {
            this.log('[%s] current light mode [temperature].', this.name);
          }
        }
      }
    }
  }
}
