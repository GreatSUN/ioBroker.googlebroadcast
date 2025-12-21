'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const axios = require('axios');
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const googleTTS = require('google-tts-api');

class GoogleBroadcast extends utils.Adapter {

    constructor(options) {
        super({ ...options, name: 'googlebroadcast' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.assistant = null;
        this.assistantReady = false;
        this.mdns = null;
        this.scanInterval = null;
        this.credsPath = null;
        this.tokensPath = null;
        
        this.server = null;
        this.serverPort = 8091;
        this.localIp = '';
        this.audioBuffers = new Map();

        this.stereoMap = new Map();
    }

    async onReady() {
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_tokens.json`);
        this.serverPort = this.config.webServerPort || 8091;
        
        if (this.config.manualIp) {
            this.localIp = this.config.manualIp;
            this.log.info(`Using manual IP: ${this.localIp}`);
        } else if (this.config.webServerIp) {
            this.localIp = this.config.webServerIp;
            this.log.info(`Using WebServer IP: ${this.localIp}`);
        } else {
            this.findLocalIp();
        }

        this.startWebServer();

        if (this.config.broadcastMode === 'cast') {
            this.log.info(`Mode: Chromecast TTS. Hosting at http://${this.localIp}:${this.serverPort}`);
            this.setState('info.connection', true, true);
        } else {
            await this.initGoogleAssistant();
        }

        this.initMdns();
        const intervalMinutes = this.config.scanInterval || 30;
        if (intervalMinutes > 0) {
            this.scanInterval = setInterval(() => this.scanNetwork(), intervalMinutes * 60 * 1000);
        }
        this.scanNetwork();

        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('groups.*.broadcast');
    }

    findLocalIp() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if ('IPv4' !== iface.family || iface.internal) continue;
                if (!this.localIp && !iface.address.startsWith('172.')) this.localIp = iface.address;
            }
        }
        this.log.info(`Auto-detected local IP: ${this.localIp}`);
    }

    startWebServer() {
        this.server = http.createServer((req, res) => {
            this.log.debug(`HTTP Request: ${req.url}`);
            const match = req.url.match(/^\/tts\/(.+)\.mp3/);
            if (match && match[1]) {
                const deviceId = match[1];
                const buffer = this.audioBuffers.get(deviceId);
                if (buffer) {
                    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buffer.length });
                    res.end(buffer);
                    return;
                }
            }
            res.writeHead(404);
            res.end();
        });
        this.server.listen(this.serverPort, () => {
            this.log.info(`WebServer started on port ${this.serverPort}`);
        });
    }

    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        const tokenState = await this.getStateAsync('tokens');
        let tokensJson = tokenState ? tokenState.val : null;

        if (credentialsJson && tokensJson) {
            fs.writeFileSync(this.credsPath, credentialsJson);
            fs.writeFileSync(this.tokensPath, tokensJson);
            this.assistant = new GoogleAssistant({ auth: { keyFilePath: this.credsPath, savedTokensPath: this.tokensPath } });
            this.assistant.on('ready', () => { 
                this.assistantReady = true; 
                this.setState('info.connection', true, true); 
                this.log.info('Assistant SDK ready');
            });
        }
    }

    async castTTS(deviceId, deviceIp, text, lang, voice) {
        this.log.debug(`castTTS called for ${deviceId} at ${deviceIp} with text: ${text}`);

        if (this.stereoMap.has(deviceId)) {
            const mapping = this.stereoMap.get(deviceId);
            this.log.info(`REDIRECTION: Device ${deviceId} belongs to Stereo Pair ${mapping.groupName}. Using IP: ${mapping.pairIp}`);
            deviceIp = mapping.pairIp;
        }

        const finalLang = lang || this.config.language || 'en-US';
        try {
            let buffer;
            if (this.config.ttsEngine === 'google_cloud') {
                const apiUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.config.googleApiKey}`;
                const response = await axios.post(apiUrl, {
                    input: { text: text },
                    voice: { languageCode: finalLang, name: (voice && voice.length > 2) ? voice : undefined },
                    audioConfig: { audioEncoding: 'MP3', speakingRate: this.config.ttsSpeed || 1 }
                });
                buffer = Buffer.from(response.data.audioContent, 'base64');
            } else {
                const ttsUrl = googleTTS.getAudioUrl(text, { lang: finalLang, host: 'https://translate.google.com' });
                const response = await axios.get(ttsUrl, { responseType: 'arraybuffer' });
                buffer = response.data;
            }

            this.audioBuffers.set(deviceId, buffer);
            const localUrl = `http://${this.localIp}:${this.serverPort}/tts/${deviceId}.mp3?t=${Date.now()}`;
            this.log.debug(`TTS generated. Local URL: ${localUrl}`);

            const client = new Client();
            client.on('error', (err) => this.log.error(`Client Error for ${deviceIp}: ${err.message}`));

            this.log.debug(`Connecting to device ${deviceIp}...`);
            client.connect(deviceIp, () => {
                this.log.debug(`Connected to ${deviceIp}. Starting heartbeat and launching app...`);
                client.heartbeat.start();
                
                client.launch(DefaultMediaReceiver, (err, player) => {
                    if (err) { 
                        this.log.error(`Launch failed for ${deviceIp}: ${err.message}`);
                        client.close(); 
                        return; 
                    }
                    this.log.debug(`App launched. Waiting 500ms for chime...`);
                    setTimeout(() => {
                        this.log.debug(`Loading media: ${localUrl}`);
                        player.load({ contentId: localUrl, contentType: 'audio/mpeg', streamType: 'BUFFERED' }, { autoplay: true }, (err) => {
                            if (err) this.log.error(`Player load error: ${err.message}`);
                        });
                    }, 500);

                    player.on('status', (s) => { 
                        if (s && s.playerState === 'IDLE') {
                            this.log.debug(`Player finished on ${deviceIp}. Closing.`);
                            client.close();
                        }
                    });
                });
            });
            setTimeout(() => this.audioBuffers.delete(deviceId), 60000);
        } catch (e) { this.log.error('Cast Error: ' + e.message); }
    }

    initMdns() {
        this.log.info('Initializing mDNS listener...');
        this.mdns = mDNS();
        this.mdns.on('response', (res) => this.processMdnsResponse(res));
    }
    
    async scanNetwork() {
        this.log.info('Scanning network for Cast devices...');
        if (this.mdns) this.mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
    }

    async processMdnsResponse(response) {
        const records = [...response.answers, ...response.additionals];
        const ptr = records.find(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');
        if (!ptr) return;

        const instanceName = ptr.data;
        let friendlyName, model;
        const txt = records.find(r => r.type === 'TXT' && r.name === instanceName);
        if (txt) {
            txt.data.forEach(buf => {
                const s = buf.toString();
                if (s.startsWith('fn=')) friendlyName = s.substring(3);
                if (s.startsWith('md=')) model = s.substring(3);
            });
        }

        const srv = records.find(r => r.type === 'SRV' && r.name === instanceName);
        if (!srv || !friendlyName) return;
        
        const aRecord = records.find(r => r.type === 'A' && r.name.toLowerCase().replace(/\.$/, '') === srv.data.target.toLowerCase().replace(/\.$/, ''));
        const ip = aRecord ? aRecord.data : null;
        if (!ip) return;

        this.log.debug(`mDNS Found: ${friendlyName} (${model}) at ${ip}`);

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        // Extended detection for Stereo Pairs
        const isStereoPair = (friendlyName.toLowerCase().includes('paar') || friendlyName.toLowerCase().includes('pair') || model === 'Google Home Stereo');
        const folder = (model === 'Google Cast Group' || isStereoPair) ? 'groups' : 'devices';

        if (isStereoPair) {
            this.log.info(`STEREO PAIR DETECTED: ${friendlyName} -> IP: ${ip}`);
            // Extract potential child name (e.g., "Living Room" from "Living Room-Paar")
            const childBase = cleanId.split('_Paar')[0].split('_Pair')[0];
            this.stereoMap.set(childBase, { pairIp: ip, groupName: friendlyName });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, { 
            type: 'device', 
            common: { name: friendlyName }, 
            native: { ip: ip, port: srv.data.port, model: model } 
        });

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.not-available`, {
            type: 'state', common: { name: 'Not Available', type: 'boolean', role: 'indicator.maintenance', read: true, write: false, def: false }
        });
        await this.setStateAsync(`${folder}.${cleanId}.not-available`, false, true);

        if (folder === 'devices' && this.stereoMap.has(cleanId)) {
            const map = this.stereoMap.get(cleanId);
            this.log.debug(`Flagging ${cleanId} as member of ${map.groupName}`);
            await this.extendObjectAsync(`${folder}.${cleanId}`, { 
                native: { StereoSpeakerGroup: map.groupName } 
            });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, {
            type: 'state', common: { name: 'Broadcast', type: 'string', role: 'text', read: true, write: true }
        });
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val) {
            this.log.debug(`State Change: ${id} = ${state.val}`);
            if (id.endsWith('broadcast_all')) {
                const devices = await this.getDevicesAsync();
                for (const dev of devices) {
                    if (dev.native && dev.native.ip) {
                        const dId = dev._id.split('.').pop();
                        this.castTTS(dId, dev.native.ip, state.val);
                    }
                }
            } else if (id.includes('.broadcast')) {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                
                const deviceObj = await this.getObjectAsync(`${this.namespace}.${folder}.${deviceId}`);
                if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                    this.castTTS(deviceId, deviceObj.native.ip, state.val);
                } else {
                    this.log.warn(`Object not found or IP missing for ${deviceId}`);
                }
            }
            this.setState(id, null, true);
        }
    }

    onUnload(callback) {
        this.log.info('Adapter shutting down...');
        if (this.server) this.server.close();
        if (this.mdns) this.mdns.destroy();
        callback();
    }
}

if (require.main === module) { new GoogleBroadcast(); } else { module.exports = (options) => new GoogleBroadcast(options); }