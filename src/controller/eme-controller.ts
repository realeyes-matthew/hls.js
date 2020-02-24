/**
 * @author Stephan Hesse <disparat@gmail.com> | <tchakabam@gmail.com>
 * @author Matthew Thompson <matthew@realeyes.com>
 *
 * DRM support for Hls.js
 */
import { Events } from '../events';
import { ErrorDetails } from '../errors';
import { logger } from '../utils/logger';
import Hls from '../hls';
import { ComponentAPI } from '../types/component-api';
import { MediaAttachedData, ManifestParsedData } from '../types/events';
import { Level } from '../types/level';
import { MediaPlaylist } from '../types/media-playlist';

interface EMEKeySessionResponse {
  keySession: MediaKeySession,
  levelOrAudioTrack: Level | MediaPlaylist
}

interface EMEInitDataResponse {
  initDataType: InitDataTypes,
  initData: Uint8Array
}

export enum InitDataTypes {
  CENC = 'cenc',
  KEYIDS = 'keyids',
  WEBM = 'webm'
}

export type RequestMediaKeySystemAccessFunc = (mediaKeySystemConfigs: MediaKeySystemConfiguration[]) => Promise<MediaKeySystemAccess>;

export type GetEMEInitDataFunc = (levelOrAudioTrack: Level | AudioTrack, initDataType: InitDataTypes | null, initData: ArrayBuffer | null) => Promise<EMEInitDataResponse>;

export type GetEMELicenseFunc = (levelOrAudioTrack: Level | AudioTrack, event: MediaKeyMessageEvent) => Promise<Uint8Array>;

/**
 * Controller to configure Encrypted Media Extensions (EME)
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Encrypted_Media_Extensions_API
 *
 * @class
 * @constructor
 */
class EMEController implements ComponentAPI {
  private hls: Hls;

  private _media: HTMLMediaElement | null = null;
  private _levels: Level[] = [];
  private _audioTracks: MediaPlaylist[] = [];
  private _initDataType: InitDataTypes | null = null;
  private _initData: ArrayBuffer | null = null;
  private _keySessions: MediaKeySession[] = [];
  private _emeConfiguring: boolean = false;
  private _emeConfigured: boolean = false;

  /**
   * User configurations
   */
  private _emeEnabled: boolean;
  private _emeInitDataInFrag: boolean;
  private _reuseEMELicense: boolean;
  private _requestMediaKeySystemAccessFunc: RequestMediaKeySystemAccessFunc | undefined
  private _getEMEInitDataFunc: GetEMEInitDataFunc | undefined;
  private _getEMELicenseFunc: GetEMELicenseFunc | undefined;

  /**
     * @constructs
     * @param {Hls} hls Our Hls.js instance
     */
  constructor(hls: Hls) {
    this.hls = hls;

    this._emeEnabled = this.hls.config.emeEnabled;
    this._requestMediaKeySystemAccessFunc = this.hls.config.requestMediaKeySystemAccessFunc;
    this._emeInitDataInFrag = this.hls.config.emeInitDataInFrag
    this._reuseEMELicense = this.hls.config.reuseEMELicense;
    this._getEMEInitDataFunc = this.hls.config.getEMEInitDataFunc;
    this._getEMELicenseFunc = this.hls.config.getEMELicenseFunc;

    this._registerListeners();
  }

  public destroy() {
    this._unregisterListeners();
  }

  private _registerListeners() {
    this.hls.on(Events.MEDIA_ATTACHED, this.onMediaAttached, this);
    this.hls.on(Events.MEDIA_DETACHED, this.onMediaDetached, this);
    this.hls.on(Events.MANIFEST_PARSED, this.onManifestParsed, this);
  }

  private _unregisterListeners() {
    this.hls.off(Events.MEDIA_ATTACHED, this.onMediaAttached, this);
    this.hls.off(Events.MEDIA_DETACHED, this.onMediaDetached, this);
    this.hls.off(Events.MANIFEST_PARSED, this.onManifestParsed, this);
  }

  onManifestParsed(event: Events.MANIFEST_PARSED, data: ManifestParsedData) {
    if (!this._emeEnabled) {
      return;
    }

    this._levels = data.levels
    this._audioTracks = data.audioTracks;

    if (!this._emeInitDataInFrag && !this._emeConfiguring && !this._emeConfigured) {
      this._configureEME();
    }
  }

  onMediaAttached(event: Events.MEDIA_ATTACHED, data: MediaAttachedData) {
    const media = data.media;

    if (media) {
      this._media = media;

      this.media.addEventListener('encrypted', (event) => {
        if (!this._emeConfiguring && !this._emeConfigured) {
          this._initDataType = event.initDataType as InitDataTypes;
          this._initData = event.initData;

          this._configureEME();
        }
      });
    }
  }

  onMediaDetached() {
    if (this._emeEnabled) {
      const keySessionClosePromises: Promise<void>[] = this._keySessions.map((keySession) => {
        return keySession.close();
      });

      Promise.all(keySessionClosePromises).then(() => {
        this._media = null;
      });
    }
  }

  /**
   * Creates requests for licenses
   * @private
   * @param {MediaKeySession} session Media Keys Session created on the Media Keys object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySession
   * @param {Level | AudioTrack} levelOrAudioTrack Either a level or audio track mapped from manifestParsed data, used by client should different licenses be
   * requred for different levels or audio tracks
   * @returns {Promise<any>} Promise resolved or rejected by updating MediaKeySession with license
   */
  private _onMediaKeySessionCreated(session: MediaKeySession, levelOrAudioTrack: any): Promise<any> {
    logger.log('Generating license request');

    return this.getEMEInitializationData(levelOrAudioTrack, this._initDataType, this._initData).then((initDataInfo) => {
      const messagePromise = new Promise((resolve, reject) => {
        session.addEventListener('message', (event: MediaKeyMessageEvent) => {
          logger.log('Received key session message, requesting license');

          this.getEMELicense(levelOrAudioTrack, event).catch(() => {
            reject(ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED);
          }).then((license: Uint8Array) => {
            logger.log('Received license data, updating key session');

            return (event.target as MediaKeySession).update(license).then(() => {
              logger.log('Key session updated with license');

              resolve();
            }).catch(() => {
              reject(ErrorDetails.KEY_SYSTEM_LICENSE_UPDATE_FAILED);
            });
          });
        });
      });

      return session.generateRequest(initDataInfo.initDataType, initDataInfo.initData).catch((err) => {
        logger.error('Failed to generate license request:', err);

        return Promise.reject(ErrorDetails.KEY_SYSTEM_GENERATE_REQUEST_FAILED);
      }).then(() => {
        return messagePromise;
      });
    });
  }

  /**
   * Creates a session on the media keys object
   * @private
   * @param {MediaKeys} mediaKeys Media Keys created on the Media Key System access object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   * @param {Level | AudioTrack} levelOrAudioTrack Either a level or audio track mapped from manifestParsed data, used by client should different licenses be
   * requred for different levels or audio tracks
   * @returns {Promise<EMEKeySessionResponse>} Promise that resolves to the Media Key Session created on the Media Keys https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySession
   * Also includes the level or audio track to associate with the session
   */
  private _onMediaKeysSet(mediaKeys: MediaKeys, levelOrAudioTrack: Level | MediaPlaylist): Promise<EMEKeySessionResponse> {
    logger.log('Creating session on media keys');

    const keySession = mediaKeys.createSession();

    this._keySessions.push(keySession);

    const keySessionResponse: EMEKeySessionResponse = {
      keySession,
      levelOrAudioTrack
    };

    return Promise.resolve(keySessionResponse);
  }

  /**
   * Sets the media keys on the media
   * @private
   * @param {MediaKeys} mediaKeys Media Keys created on the Key System Access object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   * @returns {Promise<MediaKeys>} Promise that resvoles to the created media keys  https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   */
  private _onMediaKeysCreated(mediaKeys): Promise<MediaKeys> {
    if (this._media && this._media.mediaKeys) {
      logger.log('Media keys have already been set on media');

      return Promise.resolve(this._media.mediaKeys);
    } else {
      logger.log('Setting media keys on media');

      return this.media.setMediaKeys(mediaKeys).then(() => {
        return Promise.resolve(mediaKeys);
      }).catch((err) => {
        logger.error('Failed to set media keys on media:', err);

        return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_KEYS);
      });
    }
  }

  /**
   * Creates media keys on the media key system access object
   * @private
   * @param {MediaKeySystemAccess} mediaKeySystemAccess https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemAccess
   * @returns {Promise<MediaKeys>} Promise that resolves to the created media keys https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   */
  private _onMediaKeySystemAccessObtained(mediaKeySystemAccess: MediaKeySystemAccess): Promise<MediaKeys> {
    if (this.media.mediaKeys) {
      logger.log('Media keys have already been created');

      return Promise.resolve(this.media.mediaKeys);
    } else {
      logger.log('Creating media keys');

      return mediaKeySystemAccess.createMediaKeys().catch((err) => {
        logger.error('Failed to create media-keys:', err);

        return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_KEYS);
      });
    }
  }

  /**
   * Requests Media Key System access object where user defines key system
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMediaKeySystemAccess
   * @private
   * @param {MediaKeySystemConfiguration[]} mediaKeySystemConfigs Configurations to request Media Key System access with https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemConfiguration
   * @returns {Promise<MediaKeySystemAccess} Promise that resolves to the Media Key System Access object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemAccess
   */
  private _getMediaKeySystemAccess(mediaKeySystemConfigs: MediaKeySystemConfiguration[]): Promise<MediaKeySystemAccess> {
    logger.log('Requesting encrypted media key system access');

    if (!window.navigator.requestMediaKeySystemAccess) {
      return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_ACCESS);
    }

    return this.requestMediaKeySystemAccess(mediaKeySystemConfigs).catch((err) => {
      logger.error('Failed to obtain media key system access:', err);

      return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_ACCESS);
    });
  }

  /**
   * Creates Media Key System Configurations that will be used to request Media Key System Access
   * @private
   * @param {any} levels Levels found in manifest
   * @returns {Array<MediaSystemConfiguration>} A non-empty Array of MediaKeySystemConfiguration objects https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemConfiguration
   */
  private _getSupportedMediaKeySystemConfigurations(levels: Level[]): MediaKeySystemConfiguration[] {
    const baseConfig: MediaKeySystemConfiguration = {
      audioCapabilities: [], // e.g. { contentType: 'audio/mp4; codecs="avc1.42E01E"' }
      videoCapabilities: [] // e.g. { contentType: 'video/mp4; codecs="avc1.42E01E"' }
    };

    levels.forEach((level) => {
      baseConfig.videoCapabilities!.push({
        contentType: `video/mp4; codecs="${level.videoCodec}"`
      });

      baseConfig.audioCapabilities!.push({
        contentType: `audio/mp4; codecs="${level.audioCodec}"`
      });
    });

    return [
      baseConfig
    ];
  }

  private _configureEME() {
    this.hls.trigger(Events.EME_CONFIGURING);

    this._emeConfiguring = true;

    const mediaKeySystemConfigs = this._getSupportedMediaKeySystemConfigurations(this._levels);

    this._getMediaKeySystemAccess(mediaKeySystemConfigs).then((mediaKeySystemAccess) => {
      logger.log('Obtained encrypted media key system access');

      return this._onMediaKeySystemAccessObtained(mediaKeySystemAccess);
    }).then((mediaKeys) => {
      logger.log('Created media keys');

      return this._onMediaKeysCreated(mediaKeys);
    }).then((mediaKeys) => {
      logger.log('Set media keys on media');

      let keySessionRequests: Promise<EMEKeySessionResponse>[];

      if (this._reuseEMELicense && this._levels.length) {
        keySessionRequests = [this._onMediaKeysSet(mediaKeys, this._levels[0])];
      } else {
        const levelRequests = this._levels.map((level) => {
          return this._onMediaKeysSet(mediaKeys, level);
        });

        const audioRequests = this._audioTracks.map((audioTrack) => {
          return this._onMediaKeysSet(mediaKeys, audioTrack);
        });

        keySessionRequests = levelRequests.concat(audioRequests);
      }

      return keySessionRequests.reduce((prevKeySessionRequest, currentKeySessionRequest) => {
        return prevKeySessionRequest.then((prevKeySessionResponses) => {
          return currentKeySessionRequest.then((keySessionResponse) => {
            return [...prevKeySessionResponses, keySessionResponse];
          });
        });
      }, Promise.resolve([]));
    }).then((keySessionResponses: EMEKeySessionResponse[]) => {
      logger.log('Created media key sessions');

      const licenseRequests = keySessionResponses.map((keySessionResponse: EMEKeySessionResponse) => {
        return this._onMediaKeySessionCreated(keySessionResponse.keySession, keySessionResponse.levelOrAudioTrack);
      });

      return licenseRequests.reduce((prevLicenseRequest, currentLicenseRequest) => {
        return prevLicenseRequest.then(() => {
          return currentLicenseRequest;
        });
      }, Promise.resolve());
    }).then(() => {
      logger.log('EME sucessfully configured');

      this._emeConfiguring = false;
      this._emeConfigured = true;

      this.hls.trigger(Events.EME_CONFIGURED);
    }).catch((err: string) => {
      logger.error('EME Configuration failed');

      this._emeConfiguring = false;
      this._emeConfigured = false;
    })
  }

  // Getters for EME Controller

  get media() {
    if (!this._media) {
      throw new Error('Media has not been set on EME Controller');
    }

    return this._media;
  }

  // Getters for user configurations

  get requestMediaKeySystemAccess() {
    if (!this._requestMediaKeySystemAccessFunc) {
      throw new Error('No requestMediaKeySystemAccess function configured');
    }

    return this._requestMediaKeySystemAccessFunc;
  }

  get getEMEInitializationData() {
    if (!this._getEMEInitDataFunc) {
      throw new Error('No getEMEInitData function configured');
    }

    return this._getEMEInitDataFunc;
  }

  get getEMELicense() {
    if (!this._getEMELicenseFunc) {
      throw new Error('No getEMELicense function configured');
    }

    return this._getEMELicenseFunc;
  }
}

export default EMEController;
