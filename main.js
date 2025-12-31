'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const googleTTS = require('google-tts-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

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
        
        // Explizit initialisieren
        this.credsPath = '';
        this.tokensPath = '';
        
        this.server = null;
        this.serverPort = 8091;
        this.localIp = '';
        
        this.audioBuffers = new Map();
        this.devicesByIp = new Map();
    }

    async onReady() {
        // 1. Pfade definieren (Absolut sicherstellen, dass sie Strings sind)
        const tmpDir = os.tmpdir();
        this.credsPath = path.join(tmpDir, `iobroker_google_${this.namespace}_creds.json`);
        this.tokensPath = path.join(tmpDir, `iobroker_google_${this.namespace}_tokens.json`);
        
        this.log.debug(`[INIT] Paths defined: Creds="${this.credsPath}", Tokens="${this.tokensPath}"`);

        this.serverPort = this.config.webServerPort || 8091;

        if (this.config.manualIp) {
            this.localIp = this.config.manualIp;
        } else {
            this.findLocalIp();
        }

        this.startWebServer();
        
        // 2. Assistant starten
        await this.initGoogleAssistant();

        this.initMdns();
        const intervalMinutes = this.config.scanInterval || 30;
        if (intervalMinutes > 0) {
            this.scanInterval = setInterval(() => this.scanNetwork(), intervalMinutes * 60 * 1000);
        }
        this.scanNetwork();

        this.subscribeStates('broadcast_all');
        this.subscribeStates('devices.*.broadcast');
        this.subscribeStates('devices.*.volume');
        this.subscribeStates('devices.*.youtube-url');
        this.subscribeStates('devices.*.youtube-index');
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
        this.server = http.createServer(async (req, res) => {
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
            
            // Lokale Referenzen sichern
            const cPath = this.credsPath;
            const tPath = this.tokensPath;
            
            if (!cPath || !tPath) {
                this.log.error(`[INIT] Critical: Paths are empty! cPath="${cPath}"`);
                return;
            }

            let tokensJson = null;
            if (tokenState && tokenState.val && !tokenState.val.includes('{')) {
                this.log.info('Auth code detected in tokens state.');
            } else if (tokenState) {
                tokensJson = tokenState.val;
            }

            if (credentialsJson && tokensJson) {
                // Synchrones Schreiben um Race-Conditions auszuschließen
                try {
                    fs.writeFileSync(cPath, credentialsJson);
                    fs.writeFileSync(tPath, tokensJson);
                    this.log.debug('[INIT] Files written to disk');
                } catch (err) {
                    this.log.error(`[INIT] File Write Error: ${err.message}`);
                    return;
                }
                
                // --- DEBUG & FIX: Config Objekt ---
                const assistantConfig = {
                    auth: {
                        keyFilePath: cPath,      // Standard
                        savedTokensPath: tPath,
                    },
                    conversation: {
                        lang: this.config.language || 'de-DE', 
                    },
                    // FALLBACK: Wir fügen die Keys auch auf Root-Ebene hinzu, falls die Library spinnt
                    keyFilePath: cPath, 
                    savedTokensPath: tPath
                };
                
                // Loggen, was wir übergeben (Passwörter maskiert man hier normalerweise, aber Pfade sind ok)
                this.log.debug(`[INIT] Initializing Assistant with Config: ${JSON.stringify(assistantConfig)}`);

                this.assistant = new GoogleAssistant(assistantConfig);
                
                this.assistant.on('ready', () => {
                    this.assistantReady = true;
                    this.setState('info.connection', true, true);
                    this.log.info('Assistant SDK ready');
                });
                
                this.assistant.on('error', (err) => {
                    if (err && err.toString().includes('EOF')) return;
                    this.log.error(`Assistant Error: ${err}`);
                });
            } else {
                this.log.warn(`Assistant Credentials missing. JSON present: ${!!credentialsJson}, Tokens present: ${!!tokensJson}`);
            }
        } catch (e) { 
            this.log.error(`Assistant Init Crash: ${e.message}`); 
            if (e.stack) this.log.debug(e.stack);
        }
    }

    async triggerAssistantCommand(deviceId, deviceName, command) {
        if (!this.assistant || !this.assistantReady) {
            this.log.warn('[ASSISTANT] Not ready yet. Re-initializing...');
            await this.initGoogleAssistant();
            if (!this.assistantReady) return;
        }

        const finalCommand = `${command} auf ${deviceName}`;
        this.log.info(`[ASSISTANT] Sending: "${finalCommand}"`);

        const config = { conversation: { textQuery: finalCommand } };

        this.assistant.start(config, (conversation) => {
            conversation
                .on('audio-data', () => {})
                .on('response', (text) => { if (text) this.log.debug(`[ASSISTANT] Response: ${text}`); })
                .on('ended', (error) => {
                    if (error) this.log.warn(`Assistant Command Error: ${error}`);
                });
        });
    }

    async getPlaylistTitle(url) {
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            this.log.debug(`[METADATA] Fetching oEmbed info for: ${url}`);
            const response = await axios.get(oembedUrl, { timeout: 3000 });
            
            if (response.data && response.data.title) {
                return response.data.title;
            }
            return null;
        } catch (e) {
            this.log.warn(`[METADATA] Could not extract title via oEmbed: ${e.message}`);
            return null;
        }
    }

    initMdns() {
        this.mdns = mDNS();
        this.mdns.on('response', (res) => this.processMdnsResponse(res));
    }
    
    scanNetwork() {
        if (this.mdns) this.mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
    }

    async processMdnsResponse(response) {
        const records = [...response.answers, ...response.additionals];
        const ptr = records.find(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');
        if (!ptr) return;
        
        const instanceName = ptr.data;
        let friendlyName;
        const txt = records.find(r => r.type === 'TXT' && r.name === instanceName);
        if (txt) txt.data.forEach(buf => {
            const s = buf.toString();
            if (s.startsWith('fn=')) friendlyName = s.substring(3);
        });
        
        const srv = records.find(r => r.type === 'SRV' && r.name === instanceName);
        const port = srv ? srv.data.port : 8009;
        const aRecord = records.find(r => r.type === 'A' && r.name.toLowerCase().replace(/\.$/, '') === (srv ? srv.data.target.toLowerCase().replace(/\.$/, '') : ''));
        const ip = aRecord ? aRecord.data : null;

        if (!friendlyName || !ip) return;

        const cleanId = friendlyName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const folder = 'devices';

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, { type: 'device', common: { name: friendlyName }, native: { ip: ip, port: port } });
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.volume`, { type: 'state', common: { name: 'Volume', type: 'number', role: 'level.volume', read: true, write: true } });
        this.subscribeStates(`${folder}.${cleanId}.volume`);
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, { type: 'state', common: { name: 'Broadcast', type: 'string', role: 'text', read: true, write: true } });

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.youtube-url`, { 
            type: 'state', 
            common: { name: 'YouTube URL', type: 'string', role: 'media.url', read: true, write: true, ack: true } 
        });
        this.subscribeStates(`${folder}.${cleanId}.youtube-url`);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.youtube-index`, { 
            type: 'state', 
            common: { name: 'Playlist Index', type: 'number', role: 'value', read: true, write: true, def: 1 } 
        });
        this.subscribeStates(`${folder}.${cleanId}.youtube-index`);
    }

    async castTTS(deviceId, deviceIp, text, lang, voice, devicePort) {
        try {
            const ttsUrl = googleTTS.getAudioUrl(text, { lang: lang || 'de-DE', host: 'https://translate.google.com' });
            const localUrl = `http://${this.localIp}:${this.serverPort}/tts/${deviceId}.mp3?t=${Date.now()}`;
            const response = await axios.get(ttsUrl, { responseType: 'arraybuffer' });
            this.audioBuffers.set(deviceId, response.data);
            
            const client = new Client();
            client.connect({ host: deviceIp, port: devicePort || 8009 }, () => {
                client.launch(DefaultMediaReceiver, (err, player) => {
                    if (err) { client.close(); return; }
                    setTimeout(() => {
                        player.load({ contentId: localUrl, contentType: 'audio/mpeg', streamType: 'BUFFERED' }, { autoplay: true }, () => {});
                    }, 500);
                });
            });
        } catch (e) {}
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val !== null) {
            
            const getDevInfo = async () => {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                const obj = await this.getObjectAsync(`${this.namespace}.${folder}.${deviceId}`);
                return { deviceId, obj, folder };
            };

            if (id.includes('.broadcast')) {
                const { deviceId, obj } = await getDevInfo();
                if (obj) this.castTTS(deviceId, obj.native.ip, state.val, null, null, obj.native.port);
                this.setState(id, null, true);
            } 
            else if (id.includes('.youtube-url')) {
                const { deviceId, obj, folder } = await getDevInfo();
                if (obj && obj.common && obj.common.name) {
                    const friendlyName = obj.common.name;
                    const url = state.val;
                    
                    const title = await this.getPlaylistTitle(url);
                    const playCommand = title ? `Spiele ${title}` : `Spiele ${url}`;
                    
                    this.log.info(`[FLOW] Identified Title: "${title || 'Unknown'}" -> Command: "${playCommand}"`);
                    
                    await this.triggerAssistantCommand(deviceId, friendlyName, playCommand);
                    
                    const indexState = await this.getStateAsync(`${folder}.${deviceId}.youtube-index`);
                    const index = (indexState && indexState.val) ? indexState.val : 1;
                    
                    if (index > 1) {
                        this.log.info(`[FLOW] Skipping to index ${index} in 7 seconds...`);
                        setTimeout(async () => {
                            const skipCommand = `Springe zu Titel ${index}`;
                            await this.triggerAssistantCommand(deviceId, friendlyName, skipCommand);
                        }, 7000); 
                    }
                    
                    this.setState(id, state.val, true);
                }
            }
        }
    }

    async onMessage(obj) {
        if (!obj || !obj.command) return;
        if (obj.command === 'scan') {
            this.scanNetwork();
            if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'ok' }, obj.callback);
        }
    }
    
    onUnload(callback) {
        if (this.server) this.server.close();
        if (this.mdns) this.mdns.destroy();
        callback();
    }
}

if (require.main === module) { new GoogleBroadcast(); } else { module.exports = (options) => new GoogleBroadcast(options); }