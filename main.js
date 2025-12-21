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
        this.on('message', this.onMessage.bind(this)); // Fixed: Ensured function exists
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
        this.groupsByIp = new Map();
        this.devicesByIp = new Map();
        this.groupsByNorm = new Map(); // Normalized Group Name -> Group Info
        this.devicesByNorm = new Map(); // Normalized Device Name -> Device ID
    }

    normalizeName(name) {
        return name.toLowerCase()
            .replace(/[^a-z0-9]/g, '') // remove all non-alphanumeric (spaces, dashes, underscores)
            .replace(/(pair|paar)$/, ''); // remove suffix at the end
    }

    async onReady() {
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_tokens.json`);
        this.serverPort = this.config.webServerPort || 8091;
        
        if (this.config.manualIp) {
            this.localIp = this.config.manualIp;
            this.log.info(`[CONFIG] Using manual IP: ${this.localIp}`);
        } else if (this.config.webServerIp) {
            this.localIp = this.config.webServerIp;
            this.log.info(`[CONFIG] Using WebServer IP: ${this.localIp}`);
        } else {
            this.findLocalIp();
        }

        this.startWebServer();

        if (this.config.broadcastMode === 'cast') {
            this.log.info('Mode: Chromecast TTS (Cast)');
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
        this.log.info(`[CONFIG] Auto-detected local IP: ${this.localIp}`);
    }

    startWebServer() {
        this.server = http.createServer((req, res) => {
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
        this.server.listen(this.serverPort, () => this.log.info(`WebServer running on ${this.serverPort}`));
    }

    async initGoogleAssistant() {
        try {
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
        } catch (e) { this.log.error(`Assistant Init Error: ${e.message}`); }
    }

    async castTTS(deviceId, deviceIp, text, lang, voice, devicePort) {
        this.log.debug(`[TTS] Request: ${deviceId} (${deviceIp}:${devicePort || 8009}) -> "${text}"`);

        if (this.stereoMap.has(deviceId)) {
            const mapping = this.stereoMap.get(deviceId);
            this.log.info(`[STEREO] Redirecting child ${deviceId} to Pair IP: ${mapping.pairIp}`);
            deviceIp = mapping.pairIp;
            if (mapping.pairPort) devicePort = mapping.pairPort;
        }

        try {
            let buffer;
            if (this.config.ttsEngine === 'google_cloud') {
                const apiUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.config.googleApiKey}`;
                const response = await axios.post(apiUrl, {
                    input: { text: text },
                    voice: { languageCode: lang || 'de-DE', name: voice },
                    audioConfig: { audioEncoding: 'MP3', speakingRate: 1 }
                });
                buffer = Buffer.from(response.data.audioContent, 'base64');
            } else {
                const ttsUrl = googleTTS.getAudioUrl(text, { lang: lang || 'de-DE', host: 'https://translate.google.com' });
                const response = await axios.get(ttsUrl, { responseType: 'arraybuffer' });
                buffer = response.data;
            }

            this.audioBuffers.set(deviceId, buffer);
            const localUrl = `http://${this.localIp}:${this.serverPort}/tts/${deviceId}.mp3?t=${Date.now()}`;

            const client = new Client();
            const connectOptions = { host: deviceIp, port: devicePort || 8009 };
            client.connect(connectOptions, () => {
                this.log.debug(`[CAST] Connected to ${deviceIp}:${connectOptions.port}. Starting heartbeat.`);
                client.heartbeat.start();
                client.launch(DefaultMediaReceiver, (err, player) => {
                    if (err) { 
                        this.log.error(`[CAST] Launch Error: ${err.message}`);
                        this.updateLastError(deviceId, `Launch: ${err.message}`);
                        client.close(); 
                        return; 
                    }
                    setTimeout(() => {
                        this.log.debug(`[CAST] Loading URL: ${localUrl}`);
                        player.load({ contentId: localUrl, contentType: 'audio/mpeg', streamType: 'BUFFERED' }, { autoplay: true }, (err) => {
                            if (err) this.log.error(`[CAST] Load Error: ${err.message}`);
                        });
                    }, 600);
                    player.on('status', (s) => { if (s && s.playerState === 'IDLE') client.close(); });
                });
            });
        } catch (e) { 
            this.log.error(`[TTS] Global Error: ${e.message}`);
            this.updateLastError(deviceId, e.message);
        }
    }

    async updateLastError(deviceId, msg) {
        await this.setObjectNotExistsAsync(`info.last_error`, { type: 'state', common: { name: 'Last Error', type: 'string', role: 'text', read: true, write: false } });
        this.setState(`info.last_error`, `${deviceId}: ${msg}`, true);
    }

    initMdns() {
        this.mdns = mDNS();
        this.mdns.on('response', (res) => this.processMdnsResponse(res));
    }
    
    scanNetwork() {
        this.log.debug('[mDNS] Sending discovery query...');
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
            this.log.debug(`[mDNS] TXT Record for ${instanceName}:`);
            txt.data.forEach(buf => {
                const s = buf.toString();
                this.log.debug(`  - ${s}`);
                if (s.startsWith('fn=')) friendlyName = s.substring(3);
                if (s.startsWith('md=')) model = s.substring(3);
            });
        }

        const srv = records.find(r => r.type === 'SRV' && r.name === instanceName);
        const port = srv ? srv.data.port : 8009;
        const aRecord = records.find(r => r.type === 'A' && r.name.toLowerCase().replace(/\.$/, '') === (srv ? srv.data.target.toLowerCase().replace(/\.$/, '') : ''));
        const ip = aRecord ? aRecord.data : null;

        if (!friendlyName || !ip) return;

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isStereoPair = (friendlyName.toLowerCase().includes('paar') || friendlyName.toLowerCase().includes('pair'));
        const folder = (model === 'Google Cast Group' || isStereoPair) ? 'groups' : 'devices';

        this.log.debug(`[mDNS] Found ${friendlyName} at ${ip}:${port} (${model})`);

        // Update Normalization Maps
        const normName = this.normalizeName(friendlyName);
        
        if (folder === 'groups') {
            this.groupsByIp.set(ip, { name: friendlyName, port: port, isStereo: isStereoPair });
            if (isStereoPair) {
                this.groupsByNorm.set(normName, { name: friendlyName, ip: ip, port: port });
            }

            // Check if we have a device waiting at this IP (Master)
            if (this.devicesByIp.has(ip) && isStereoPair) {
                const childId = this.devicesByIp.get(ip);
                this.stereoMap.set(childId, { pairIp: ip, pairPort: port, groupName: friendlyName });
                this.extendObjectAsync(`devices.${childId}`, { native: { StereoSpeakerGroup: friendlyName } });
            }

            // Fuzzy Match for Slave Speaker (Different IP)
            // e.g., Device: "Living Room", Group: "Living Room-Paar" -> Norm: "livingroom"
            if (isStereoPair && this.devicesByNorm.has(normName)) {
                const childId = this.devicesByNorm.get(normName);
                this.log.info(`[STEREO] Fuzzy Link: ${childId} -> ${friendlyName} (Group)`);
                this.stereoMap.set(childId, { pairIp: ip, pairPort: port, groupName: friendlyName });
                this.extendObjectAsync(`devices.${childId}`, { native: { StereoSpeakerGroup: friendlyName } });
            }

            if (isStereoPair) {
                const childBase = cleanId.split('_Paar')[0].split('_Pair')[0];
                this.stereoMap.set(childBase, { pairIp: ip, pairPort: port, groupName: friendlyName });
            }
        } else {
            this.devicesByIp.set(ip, cleanId);
            this.devicesByNorm.set(normName, cleanId);

            // Check if this device shares IP with a Group (Master)
            if (this.groupsByIp.has(ip)) {
                const g = this.groupsByIp.get(ip);
                if (g.isStereo) {
                    this.stereoMap.set(cleanId, { pairIp: ip, pairPort: g.port, groupName: g.name });
                }
            }

            // Fuzzy Match for Slave Speaker (Check if matching Group exists)
            if (this.groupsByNorm.has(normName)) {
                const g = this.groupsByNorm.get(normName);
                this.log.info(`[STEREO] Fuzzy Link: ${friendlyName} -> ${g.name} (Group)`);
                this.stereoMap.set(cleanId, { pairIp: g.ip, pairPort: g.port, groupName: g.name });
            }
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, { type: 'device', common: { name: friendlyName }, native: { ip: ip, port: port, model: model } });
        
        // Add Availability State
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.not-available`, { type: 'state', common: { name: 'Not Available', type: 'boolean', role: 'indicator.maintenance', read: true, write: false, def: false } });
        this.setState(`${folder}.${cleanId}.not-available`, false, true);

        // Flag child speakers
        if (folder === 'devices' && this.stereoMap.has(cleanId)) {
            await this.extendObjectAsync(`${folder}.${cleanId}`, { native: { StereoSpeakerGroup: this.stereoMap.get(cleanId).groupName } });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, { type: 'state', common: { name: 'Broadcast', type: 'string', role: 'text', read: true, write: true } });
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val) {
            if (id.endsWith('broadcast_all')) {
                const devices = await this.getDevicesAsync();
                for (const dev of devices) {
                    if (dev.native && dev.native.ip) this.castTTS(dev._id.split('.').pop(), dev.native.ip, state.val, null, null, dev.native.port);
                }
            } else if (id.includes('.broadcast')) {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                const deviceObj = await this.getObjectAsync(`${this.namespace}.${folder}.${deviceId}`);
                if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                    this.castTTS(deviceId, deviceObj.native.ip, state.val, null, null, deviceObj.native.port);
                }
            }
            this.setState(id, null, true);
        }
    }

    onMessage(obj) { 
        if (obj && obj.command === 'scan') this.scanNetwork(); 
    }

    onUnload(callback) {
        if (this.server) this.server.close();
        if (this.mdns) this.mdns.destroy();
        callback();
    }
}

if (require.main === module) { new GoogleBroadcast(); } else { module.exports = (options) => new GoogleBroadcast(options); }