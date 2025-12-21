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
        this.activeDevices = new Set(); // Track devices seen in current scan
    }

    async onReady() {
        this.credsPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(os.tmpdir(), `iobroker_google_${this.namespace}_tokens.json`);
        this.serverPort = this.config.webServerPort || 8091;
        
        if (this.config.manualIp) {
            this.localIp = this.config.manualIp;
        } else if (this.config.webServerIp) {
            this.localIp = this.config.webServerIp;
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
        this.server.listen(this.serverPort);
    }

    async initGoogleAssistant() {
        const credentialsJson = this.config.jsonCredentials;
        const tokenState = await this.getStateAsync('tokens');
        let tokensJson = tokenState ? tokenState.val : null;

        if (this.config.authCode && credentialsJson && !tokensJson) {
            try {
                const keys = JSON.parse(credentialsJson);
                const clientConfig = keys.installed || keys.web;
                const oauth2Client = new google.auth.OAuth2(clientConfig.client_id, clientConfig.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
                const { tokens } = await oauth2Client.getToken(this.config.authCode);
                tokensJson = JSON.stringify(tokens);
                await this.setStateAsync('tokens', tokensJson, true);
            } catch (e) { this.log.error('OAuth Error: ' + e.message); }
        }

        if (credentialsJson && tokensJson) {
            fs.writeFileSync(this.credsPath, credentialsJson);
            fs.writeFileSync(this.tokensPath, tokensJson);
            this.assistant = new GoogleAssistant({ auth: { keyFilePath: this.credsPath, savedTokensPath: this.tokensPath } });
            this.assistant.on('ready', () => { this.assistantReady = true; this.setState('info.connection', true, true); });
        }
    }

    async castTTS(deviceId, deviceIp, text, lang, voice) {
        if (this.stereoMap.has(deviceId)) {
            const mapping = this.stereoMap.get(deviceId);
            this.log.info(`Redirecting ${deviceId} to Stereo Pair IP: ${mapping.pairIp}`);
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

            const client = new Client();
            client.connect(deviceIp, () => {
                client.heartbeat.start();
                client.launch(DefaultMediaReceiver, (err, player) => {
                    if (err) { client.close(); return; }
                    setTimeout(() => {
                        player.load({ contentId: localUrl, contentType: 'audio/mpeg', streamType: 'BUFFERED' }, { autoplay: true }, () => {});
                    }, 500);
                    player.on('status', (s) => { if (s && s.playerState === 'IDLE') client.close(); });
                });
            });
            setTimeout(() => this.audioBuffers.delete(deviceId), 60000);
        } catch (e) { this.log.error('Cast Error: ' + e.message); }
    }

    initMdns() {
        this.mdns = mDNS();
        this.mdns.on('response', (res) => this.processMdnsResponse(res));
    }
    
    async scanNetwork() {
        this.log.debug('Starting network scan. Resetting availability flags...');
        
        // Fetch all current devices from ioBroker to mark them as potentially offline
        const devices = await this.getDevicesAsync();
        for (const dev of devices) {
            const idParts = dev._id.split('.');
            const folder = idParts[idParts.length - 2];
            const cleanId = idParts[idParts.length - 1];
            await this.setStateAsync(`${folder}.${cleanId}.not-available`, true, true);
        }

        if (this.mdns) {
            this.mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
        }
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

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isStereoPair = (friendlyName.toLowerCase().includes('paar') || friendlyName.toLowerCase().includes('pair'));
        const folder = (model === 'Google Cast Group' || isStereoPair) ? 'groups' : 'devices';

        if (isStereoPair) {
            const childBase = cleanId.split('_Paar')[0].split('_Pair')[0];
            this.stereoMap.set(childBase, { pairIp: ip, groupName: friendlyName });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, { 
            type: 'device', 
            common: { name: friendlyName }, 
            native: { ip: ip, port: srv.data.port } 
        });

        // Availability State
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.not-available`, {
            type: 'state', common: { name: 'Not Available', type: 'boolean', role: 'indicator.maintenance', read: true, write: false, def: false }
        });
        await this.setStateAsync(`${folder}.${cleanId}.not-available`, false, true);

        if (folder === 'devices' && this.stereoMap.has(cleanId)) {
            const map = this.stereoMap.get(cleanId);
            await this.extendObjectAsync(`${folder}.${cleanId}`, { native: { StereoSpeakerGroup: map.groupName } });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, {
            type: 'state', common: { name: 'Broadcast', type: 'string', role: 'text', read: true, write: true }
        });
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val) {
            if (id.endsWith('broadcast_all')) {
                const devices = await this.getDevicesAsync();
                devices.forEach(async (dev) => {
                    const idParts = dev._id.split('.');
                    const cleanId = idParts[idParts.length - 1];
                    const folder = idParts[idParts.length - 2];
                    const avail = await this.getStateAsync(`${folder}.${cleanId}.not-available`);
                    if (dev.native && dev.native.ip && (!avail || avail.val === false)) {
                        this.castTTS(cleanId, dev.native.ip, state.val);
                    }
                });
            } else if (id.includes('.broadcast')) {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                const avail = await this.getStateAsync(`${folder}.${deviceId}.not-available`);
                
                if (avail && avail.val === true) {
                    this.log.warn(`Cannot broadcast to ${deviceId}: Device is marked as not available.`);
                } else {
                    const deviceObj = await this.getObjectAsync(id.substring(0, id.lastIndexOf('.')));
                    if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                        this.castTTS(deviceId, deviceObj.native.ip, state.val);
                    }
                }
            }
            this.setState(id, null, true);
        }
    }

    async onMessage(obj) { if (obj.command === 'scan') this.scanNetwork(); }

    onUnload(callback) {
        if (this.server) this.server.close();
        if (this.mdns) this.mdns.destroy();
        callback();
    }
}

if (require.main === module) { new GoogleBroadcast(); } else { module.exports = (options) => new GoogleBroadcast(options); }