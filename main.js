'use strict';

const utils = require('@iobroker/adapter-core');
const GoogleAssistant = require('google-assistant');
const mDNS = require('multicast-dns');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const axios = require('axios');
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const googleTTS = require('google-tts-api');
const playDl = require('play-dl');

// YouTube OAuth Configuration - credentials are loaded from jsonCredentials config (same as Assistant SDK)
const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube'];

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
        this.groupsByIp = new Map();
        this.devicesByIp = new Map();
        this.groupsByNorm = new Map();
        this.devicesByNorm = new Map();
        this.devicesByModel = new Map();
    }

    normalizeName(name) {
        return name.toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .replace(/(pair|paar)$/, '');
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
            await this.initPlayDl();
        } else {
            await this.initGoogleAssistant();
            await this.initPlayDl();
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
        this.subscribeStates('devices.*.volume');
        this.subscribeStates('groups.*.volume');
        this.subscribeStates('devices.*.youtube-url');
        this.subscribeStates('groups.*.youtube-url');

        await this.ensureYouTubeUrlStates();

        const pollIntervalSec = this.config.pollInterval || 30;
        this.log.info(`[CONFIG] Volume Poll Interval: ${pollIntervalSec}s`);
        this.pollVolume();
        if (pollIntervalSec > 0) {
            setInterval(() => this.pollVolume(), pollIntervalSec * 1000);
        }
    }

    async ensureYouTubeUrlStates() {
        const folders = ['devices', 'groups'];
        for (const folder of folders) {
            const devices = await this.getDevicesAsync();
            for (const dev of devices) {
                const devId = dev._id;
                if (!devId.includes(`.${folder}.`)) continue;
                
                const cleanId = devId.split('.').pop();
                await this.setObjectNotExistsAsync(`${folder}.${cleanId}.youtube-url`, {
                    type: 'state',
                    common: {
                        name: 'YouTube URL',
                        type: 'string',
                        role: 'media.url',
                        read: true,
                        write: true,
                        desc: 'Play a YouTube video/audio URL on this device'
                    }
                });
                this.subscribeStates(`${folder}.${cleanId}.youtube-url`);
            }
        }
        this.log.info('[INIT] Ensured youtube-url states exist for all devices');
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
        this.server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost:${this.serverPort}`);
            
            // Handle YouTube OAuth callback (Automatic mode)
            if (url.pathname === '/oauth/youtube') {
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');
                
                if (error) {
                    this.log.error(`[YOUTUBE-AUTH] OAuth error: ${error}`);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<!DOCTYPE html><html><head><title>YouTube Authorization Failed</title></head>
                        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: #d32f2f;">❌ Authorization Failed</h1>
                        <p>Error: ${error}</p>
                        <p>Please close this tab and try again.</p>
                        </body></html>`);
                    return;
                }
                
                if (code) {
                    try {
                        const tokens = await this.exchangeYouTubeCode(code);
                        if (tokens) {
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(`<!DOCTYPE html><html><head><title>YouTube Authorization Successful</title></head>
                                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                                <h1 style="color: #4caf50;">✓ YouTube Premium Connected!</h1>
                                <p>Authorization successful. You can close this tab.</p>
                                <script>setTimeout(function() { window.close(); }, 3000);</script>
                                </body></html>`);
                        } else {
                            throw new Error('Token exchange failed');
                        }
                    } catch (e) {
                        this.log.error(`[YOUTUBE-AUTH] Token exchange error: ${e.message}`);
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`<!DOCTYPE html><html><head><title>YouTube Authorization Failed</title></head>
                            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                            <h1 style="color: #d32f2f;">❌ Token Exchange Failed</h1>
                            <p>Error: ${e.message}</p>
                            <p>Please close this tab and try again using Safe Mode.</p>
                            </body></html>`);
                    }
                    return;
                }
                
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><title>Invalid Request</title></head>
                    <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                    <h1 style="color: #ff9800;">⚠️ Invalid Request</h1>
                    <p>No authorization code received.</p>
                    </body></html>`);
                return;
            }
            
            // Handle TTS audio streaming
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

    /**
     * Parse YouTube OAuth credentials from jsonCredentials config
     * @returns {object|null} - {client_id, client_secret} or null
     */
    getYouTubeCredentials() {
        try {
            const credentialsJson = this.config.jsonCredentials;
            if (!credentialsJson) {
                this.log.error('[YOUTUBE-AUTH] No jsonCredentials configured');
                return null;
            }
            
            const credentials = JSON.parse(credentialsJson);
            const config = credentials.installed || credentials.web || credentials;
            
            if (!config.client_id || !config.client_secret) {
                this.log.error('[YOUTUBE-AUTH] Invalid credentials: missing client_id or client_secret');
                return null;
            }
            
            return {
                client_id: config.client_id,
                client_secret: config.client_secret,
                redirect_uris: config.redirect_uris || []
            };
        } catch (e) {
            this.log.error(`[YOUTUBE-AUTH] Failed to parse credentials: ${e.message}`);
            return null;
        }
    }

    /**
     * Exchange YouTube authorization code for tokens
     * @param {string} code - Authorization code from Google OAuth
     * @returns {object|null} - Token object or null on failure
     */
    async exchangeYouTubeCode(code) {
        try {
            const creds = this.getYouTubeCredentials();
            if (!creds) {
                throw new Error('No valid OAuth credentials configured');
            }
            
            // Use the actual server IP for redirect URI (must match what was used in auth URL)
            const redirectUri = `http://${this.localIp}:${this.serverPort}/oauth/youtube`;
            
            this.log.info(`[YOUTUBE-AUTH] Exchanging code for tokens (redirect: ${redirectUri})...`);
            
            const oAuth2Client = new OAuth2Client(creds.client_id, creds.client_secret, redirectUri);
            const { tokens } = await oAuth2Client.getToken(code);
            
            this.log.info(`[YOUTUBE-AUTH] Token exchange successful`);
            this.log.debug(`[YOUTUBE-AUTH] Tokens: access_token=${tokens.access_token ? 'present' : 'missing'}, refresh_token=${tokens.refresh_token ? 'present' : 'missing'}`);
            
            await this.setObjectNotExistsAsync('youtube_oauth_tokens', {
                type: 'state',
                common: {
                    name: 'YouTube OAuth Tokens',
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: true,
                    desc: 'YouTube Premium OAuth tokens for play-dl'
                }
            });
            await this.setStateAsync('youtube_oauth_tokens', JSON.stringify(tokens), true);
            
            await this.initPlayDl();
            
            return tokens;
        } catch (e) {
            this.log.error(`[YOUTUBE-AUTH] Exchange error: ${e.message}`);
            return null;
        }
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

    async initPlayDl() {
        try {
            await this.setObjectNotExistsAsync('youtube_oauth_tokens', {
                type: 'state',
                common: {
                    name: 'YouTube OAuth Tokens',
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: true,
                    desc: 'YouTube Premium OAuth tokens'
                }
            });
            
            const ytOAuthState = await this.getStateAsync('youtube_oauth_tokens');
            const ytOAuthTokens = ytOAuthState ? ytOAuthState.val : null;
            
            if (ytOAuthTokens && ytOAuthTokens !== '') {
                const tokens = JSON.parse(ytOAuthTokens);
                
                if (tokens.access_token) {
                    this.log.info('[YOUTUBE] OAuth tokens found, configuring play-dl...');
                    
                    if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
                        this.log.info('[YOUTUBE] Access token expired, refreshing...');
                        const refreshedTokens = await this.refreshYouTubeToken(tokens);
                        if (refreshedTokens) {
                            await this.setPlayDlToken(refreshedTokens);
                        }
                    } else {
                        await this.setPlayDlToken(tokens);
                        this.log.debug(`[YOUTUBE] Token expires: ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown'}`);
                    }
                } else {
                    this.log.warn('[YOUTUBE] OAuth tokens present but missing access_token');
                }
            } else {
                this.log.info('[YOUTUBE] No YouTube tokens found. YouTube Premium features may require authentication.');
            }
        } catch (e) {
            this.log.warn(`[YOUTUBE] play-dl init: ${e.message}`);
        }
    }

    /**
     * Set play-dl token for YouTube authentication
     * @param {object} tokens - OAuth tokens from Google
     */
    async setPlayDlToken(tokens) {
        try {
            const creds = this.getYouTubeCredentials();
            if (!creds) {
                this.log.warn('[YOUTUBE] Cannot set play-dl token: no credentials configured');
                return;
            }
            
            const playDlToken = {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                token_type: tokens.token_type || 'Bearer',
                expiry_date: tokens.expiry_date
            };
            
            await playDl.setToken({
                youtube: {
                    cookie: ''
                }
            });
            
            this.youtubeTokens = playDlToken;
            this.youtubeCredentials = creds;
            
            this.log.info('[YOUTUBE] play-dl configured with OAuth tokens');
        } catch (e) {
            this.log.error(`[YOUTUBE] Failed to set play-dl token: ${e.message}`);
        }
    }

    /**
     * Refresh YouTube OAuth token
     * @param {object} tokens - Current token object with refresh_token
     */
    async refreshYouTubeToken(tokens) {
        try {
            if (!tokens.refresh_token) {
                this.log.error('[YOUTUBE-AUTH] No refresh token available');
                return null;
            }
            
            const creds = this.getYouTubeCredentials();
            if (!creds) {
                throw new Error('No valid OAuth credentials configured');
            }
            
            const oAuth2Client = new OAuth2Client(creds.client_id, creds.client_secret);
            oAuth2Client.setCredentials(tokens);
            
            const { credentials } = await oAuth2Client.refreshAccessToken();
            
            this.log.info('[YOUTUBE-AUTH] Token refreshed successfully');
            
            await this.setStateAsync('youtube_oauth_tokens', JSON.stringify(credentials), true);
            
            return credentials;
        } catch (e) {
            this.log.error(`[YOUTUBE-AUTH] Token refresh error: ${e.message}`);
            return null;
        }
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

    async castYouTube(deviceId, deviceIp, youtubeUrl, devicePort) {
        this.log.debug(`[YOUTUBE] Request: ${deviceId} (${deviceIp}:${devicePort || 8009}) -> "${youtubeUrl}"`);

        if (this.stereoMap.has(deviceId)) {
            const mapping = this.stereoMap.get(deviceId);
            this.log.info(`[STEREO] Redirecting child ${deviceId} to Pair IP: ${mapping.pairIp}`);
            deviceIp = mapping.pairIp;
            if (mapping.pairPort) devicePort = mapping.pairPort;
        }

        try {
            if (!playDl.yt_validate(youtubeUrl)) {
                this.log.error(`[YOUTUBE] Invalid YouTube URL: ${youtubeUrl}`);
                this.updateLastError(deviceId, `Invalid YouTube URL: ${youtubeUrl}`);
                return;
            }

            const videoInfo = await playDl.video_info(youtubeUrl);
            const title = videoInfo.video_details.title || 'YouTube Stream';
            const artist = videoInfo.video_details.channel?.name || 'YouTube';
            
            this.log.debug(`[YOUTUBE] Video: "${title}" by ${artist}`);

            const stream = await playDl.stream(youtubeUrl, { quality: 2 });
            const streamUrl = stream.url;
            
            if (!streamUrl || !streamUrl.includes('googlevideo.com')) {
                this.log.error(`[YOUTUBE] Failed to get valid stream URL`);
                this.updateLastError(deviceId, 'Failed to get valid stream URL from YouTube');
                return;
            }

            this.log.debug(`[YOUTUBE] Stream URL obtained: ${streamUrl.substring(0, 100)}...`);

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
                        this.log.debug(`[YOUTUBE] Loading stream URL to device`);
                        const media = {
                            contentId: streamUrl,
                            contentType: 'audio/mp4',
                            streamType: 'BUFFERED',
                            metadata: {
                                metadataType: 3,
                                title: title,
                                artist: artist
                            }
                        };
                        player.load(media, { autoplay: true }, (err) => {
                            if (err) {
                                this.log.error(`[YOUTUBE] Load Error: ${err.message}`);
                                this.updateLastError(deviceId, `Load: ${err.message}`);
                            } else {
                                this.log.info(`[YOUTUBE] Now playing: "${title}" on ${deviceId}`);
                            }
                        });
                    }, 600);
                    player.on('status', (s) => {
                        if (s && s.playerState === 'IDLE' && s.idleReason === 'FINISHED') {
                            client.close();
                        }
                    });
                });
            });

            client.on('error', (err) => {
                this.log.error(`[YOUTUBE] Client Error: ${err.message}`);
                this.updateLastError(deviceId, `Client: ${err.message}`);
                client.close();
            });

        } catch (e) {
            this.log.error(`[YOUTUBE] Global Error: ${e.message}`);
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
        this.log.silly('[mDNS] Sending discovery query...');
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
            this.log.silly(`[mDNS] TXT Record for ${instanceName}:`);
            txt.data.forEach(buf => {
                const s = buf.toString();
                this.log.silly(`  - ${s}`);
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

        this.log.silly(`[mDNS] Found ${friendlyName} at ${ip}:${port} (${model})`);

        const normName = this.normalizeName(friendlyName);
        
        if (folder === 'groups') {
            this.groupsByIp.set(ip, { name: friendlyName, port: port, isStereo: isStereoPair });
            if (isStereoPair) {
                this.groupsByNorm.set(normName, { name: friendlyName, ip: ip, port: port });
            }

            if (this.devicesByIp.has(ip) && isStereoPair) {
                const childId = this.devicesByIp.get(ip);
                this.stereoMap.set(childId, { pairIp: ip, pairPort: port, groupName: friendlyName });
                this.extendObjectAsync(`devices.${childId}`, { native: { StereoSpeakerGroup: friendlyName } });
            }

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

            if (this.groupsByIp.has(ip)) {
                const g = this.groupsByIp.get(ip);
                if (g.isStereo) {
                    this.stereoMap.set(cleanId, { pairIp: ip, pairPort: g.port, groupName: g.name });
                }
            }

            if (this.groupsByNorm.has(normName)) {
                const g = this.groupsByNorm.get(normName);
                this.log.info(`[STEREO] Fuzzy Link: ${friendlyName} -> ${g.name} (Group)`);
                this.stereoMap.set(cleanId, { pairIp: g.ip, pairPort: g.port, groupName: g.name });
            }
        }

        const mdnsInstanceId = instanceName.split('._googlecast')[0];
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}`, { type: 'device', common: { name: friendlyName }, native: { ip: ip, port: port, model: model, mdnsId: mdnsInstanceId } });
        
        this.devicesByModel.set(mdnsInstanceId, { cleanId: cleanId, folder: folder });
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.model-name`, { type: 'state', common: { name: 'Model Name', type: 'string', role: 'text', read: true, write: false, desc: 'Device model name from mDNS (md= field)' } });
        this.setState(`${folder}.${cleanId}.model-name`, model || '', true);
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.mdns-id`, { type: 'state', common: { name: 'mDNS Instance ID', type: 'string', role: 'text', read: true, write: false, desc: 'mDNS instance identifier (e.g., NestAudio5124)' } });
        this.setState(`${folder}.${cleanId}.mdns-id`, mdnsInstanceId, true);
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.not-available`, { type: 'state', common: { name: 'Not Available', type: 'boolean', role: 'indicator.maintenance', read: true, write: false, def: false } });
        this.setState(`${folder}.${cleanId}.not-available`, false, true);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.no-response-ts`, { type: 'state', common: { name: 'No Response Since', type: 'number', role: 'date', read: true, write: false, def: null, desc: 'Timestamp when device stopped responding (null if available)' } });
        this.setState(`${folder}.${cleanId}.no-response-ts`, null, true);

        if (folder === 'devices' && this.stereoMap.has(cleanId)) {
            await this.extendObjectAsync(`${folder}.${cleanId}`, { native: { StereoSpeakerGroup: this.stereoMap.get(cleanId).groupName } });
        }

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.broadcast`, { type: 'state', common: { name: 'Broadcast', type: 'string', role: 'text', read: true, write: true } });
        
        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.volume`, { type: 'state', common: { name: 'Volume', type: 'number', role: 'level.volume', read: true, write: true, min: 0, max: 100, unit: '%' } });
        this.subscribeStates(`${folder}.${cleanId}.volume`);

        await this.setObjectNotExistsAsync(`${folder}.${cleanId}.youtube-url`, { type: 'state', common: { name: 'YouTube URL', type: 'string', role: 'media.url', read: true, write: true, desc: 'Play a YouTube video/audio URL on this device' } });
        this.subscribeStates(`${folder}.${cleanId}.youtube-url`);
    }

    async setVolume(ip, port, level) {
        if (!ip) return;
        try {
            const client = new Client();
            const connectOptions = { host: ip, port: port || 8009 };
            client.connect(connectOptions, () => {
                client.setVolume({ level: level / 100 }, (err) => {
                   if (err) this.log.error(`[VOLUME] Set Error: ${err.message}`);
                   client.close();
                });
            });
            client.on('error', (err) => {
                this.log.error(`[VOLUME] Connection Error: ${err.message}`);
                client.close();
            });
        } catch (e) {
            this.log.error(`[VOLUME] Global Error: ${e.message}`);
        }
    }

    async pollVolume() {
        const folders = ['devices', 'groups'];
        const removalTimeoutHours = this.config.deviceRemovalTimeout || 24;

        for (const folder of folders) {
            const states = await this.getStatesAsync(`${folder}.*.volume`);
            if (!states) continue;

            const uniqueIds = new Set();
            for (const id of Object.keys(states)) {
                const parts = id.split('.');
                if (parts.length >= 4) uniqueIds.add(parts.slice(0, parts.length - 1).join('.'));
            }

            for (const deviceId of uniqueIds) {
                const obj = await this.getObjectAsync(deviceId);
                
                const relId = deviceId.split('.').slice(2).join('.');
                const cleanId = relId.split('.').pop();
                
                if (!obj || !obj.native || !obj.native.ip) {
                    const modelLookup = this.devicesByModel.get(cleanId);
                    if (modelLookup) {
                        this.log.debug(`[POLL] Found device by mDNS ID lookup: ${cleanId} -> ${modelLookup.cleanId}`);
                        continue;
                    }
                    
                    this.log.debug(`[POLL] Skipping unknown device: ${cleanId} (no object or IP found)`);
                    continue;
                }
                
                const ip = obj.native.ip;
                const port = obj.native.port || 8009;

                const client = new Client();
                let connected = false;
                const timeout = setTimeout(() => {
                    if (!connected) {
                        client.close();
                        this.handleDeviceUnavailable(folder, cleanId, removalTimeoutHours);
                    }
                }, 5000);

                client.on('error', () => {
                    client.close();
                    if (!connected) {
                        clearTimeout(timeout);
                        this.handleDeviceUnavailable(folder, cleanId, removalTimeoutHours);
                    }
                });

                try {
                    client.connect({ host: ip, port: port }, () => {
                         client.getStatus((err, status) => {
                             clearTimeout(timeout);
                             connected = true;
                             if (!err && status) {
                                 this.handleDeviceAvailable(folder, cleanId);
                                 if (status.volume) {
                                     const vol = Math.round(status.volume.level * 100);
                                     this.setState(`${relId}.volume`, vol, true);
                                 }
                             } else {
                                 this.handleDeviceUnavailable(folder, cleanId, removalTimeoutHours);
                             }
                             client.close();
                         });
                    });
                } catch (e) {
                    clearTimeout(timeout);
                    this.handleDeviceUnavailable(folder, cleanId, removalTimeoutHours);
                }
            }
        }
    }

    async handleDeviceAvailable(folder, cleanId) {
        const relId = `${folder}.${cleanId}`;
        
        const deviceObj = await this.getObjectAsync(relId);
        if (!deviceObj) {
            this.log.debug(`[POLL] Device ${cleanId} object not found, skipping availability update`);
            return;
        }
        
        this.setState(`${relId}.not-available`, false, true);
        this.setState(`${relId}.no-response-ts`, null, true);
    }

    async handleDeviceUnavailable(folder, cleanId, removalTimeoutHours) {
        const relId = `${folder}.${cleanId}`;
        
        const deviceObj = await this.getObjectAsync(relId);
        if (!deviceObj) {
            this.log.debug(`[POLL] Device ${cleanId} object not found, skipping unavailability update`);
            return;
        }
        
        await this.setObjectNotExistsAsync(`${relId}.no-response-ts`, {
            type: 'state',
            common: {
                name: 'No Response Since',
                type: 'number',
                role: 'date',
                read: true,
                write: false,
                def: null,
                desc: 'Timestamp when device stopped responding (null if available)'
            }
        });
        
        this.setState(`${relId}.not-available`, true, true);
        
        const tsState = await this.getStateAsync(`${relId}.no-response-ts`);
        let noResponseTs = tsState ? tsState.val : null;
        
        if (noResponseTs === null || noResponseTs === undefined) {
            noResponseTs = Date.now();
            this.setState(`${relId}.no-response-ts`, noResponseTs, true);
            this.log.debug(`[POLL] Device ${cleanId} became unavailable, recording timestamp`);
        }
        
        if (removalTimeoutHours > 0) {
            const elapsedMs = Date.now() - noResponseTs;
            const elapsedHours = elapsedMs / (1000 * 60 * 60);
            
            this.log.debug(`[POLL] Device ${cleanId} unavailable for ${elapsedHours.toFixed(2)} hours (threshold: ${removalTimeoutHours}h)`);
            
            if (elapsedHours >= removalTimeoutHours) {
                this.log.warn(`[CLEANUP] Removing device ${cleanId} after ${removalTimeoutHours} hours without response`);
                await this.deleteDeviceAsync(relId);
                
                for (const [ip, id] of this.devicesByIp.entries()) {
                    if (id === cleanId) {
                        this.devicesByIp.delete(ip);
                        break;
                    }
                }
                this.stereoMap.delete(cleanId);
            }
        }
    }

    async deleteDeviceAsync(devicePath) {
        try {
            const states = await this.getStatesAsync(`${devicePath}.*`);
            if (states) {
                for (const stateId of Object.keys(states)) {
                    const relId = stateId.replace(`${this.namespace}.`, '');
                    await this.delObjectAsync(relId);
                }
            }
            await this.delObjectAsync(devicePath);
            this.log.info(`[CLEANUP] Successfully deleted ${devicePath}`);
        } catch (e) {
            this.log.error(`[CLEANUP] Error deleting ${devicePath}: ${e.message}`);
        }
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val !== null) {
            if (id.endsWith('broadcast_all')) {
                const devices = await this.getDevicesAsync();
                for (const dev of devices) {
                    if (dev.native && dev.native.ip) this.castTTS(dev._id.split('.').pop(), dev.native.ip, state.val, null, null, dev.native.port);
                }
                this.setState(id, null, true);
            } else if (id.includes('.broadcast')) {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                const deviceObj = await this.getObjectAsync(`${this.namespace}.${folder}.${deviceId}`);
                if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                    this.castTTS(deviceId, deviceObj.native.ip, state.val, null, null, deviceObj.native.port);
                }
                this.setState(id, null, true);
            } else if (id.includes('.volume')) {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                let deviceObj = await this.getObjectAsync(`${this.namespace}.${folder}.${deviceId}`);
                
                if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                    let targetIp = deviceObj.native.ip;
                    let targetPort = deviceObj.native.port;

                    if (this.stereoMap.has(deviceId)) {
                         const mapping = this.stereoMap.get(deviceId);
                         this.log.debug(`[VOLUME] Redirecting volume set for ${deviceId} to Group ${mapping.groupName}`);
                         targetIp = mapping.pairIp;
                         if (mapping.pairPort) targetPort = mapping.pairPort;
                    }

                    this.setVolume(targetIp, targetPort, state.val);
                }
                this.setState(id, state.val, true);
            } else if (id.includes('.youtube-url')) {
                const parts = id.split('.');
                const deviceId = parts[parts.length - 2];
                const folder = parts[parts.length - 3];
                const deviceObj = await this.getObjectAsync(`${this.namespace}.${folder}.${deviceId}`);
                if (deviceObj && deviceObj.native && deviceObj.native.ip) {
                    this.castYouTube(deviceId, deviceObj.native.ip, state.val, deviceObj.native.port);
                }
                this.setState(id, null, true);
            }
        }
    }

    async onMessage(obj) {
        if (!obj || !obj.command) return;
        
        switch (obj.command) {
            case 'getInterfaces':
                // Return network interfaces and server info for admin UI
                const interfaces = os.networkInterfaces();
                const list = [];
                for (const ifaceName in interfaces) {
                    if (!interfaces.hasOwnProperty(ifaceName)) continue;
                    interfaces[ifaceName].forEach((iface) => {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            list.push({ name: ifaceName, address: iface.address });
                        }
                    });
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {
                        result: list,
                        webServerPort: this.serverPort,
                        webServerIp: this.localIp
                    }, obj.callback);
                }
                break;
                
            case 'scan':
                this.scanNetwork();
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
                }
                break;
                
            case 'clearTokens':
                await this.setStateAsync('tokens', '', true);
                await this.setStateAsync('youtube_oauth_tokens', '', true);
                this.log.info('[AUTH] Cleared stored tokens for re-authentication');
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
                }
                break;
                
            case 'exchangeYouTubeCode':
                if (obj.message && obj.message.code) {
                    try {
                        const tokens = await this.exchangeYouTubeCodeSafeMode(obj.message.code);
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, {
                                success: !!tokens,
                                tokens: tokens ? { hasAccessToken: !!tokens.access_token, hasRefreshToken: !!tokens.refresh_token } : null
                            }, obj.callback);
                        }
                    } catch (e) {
                        this.log.error(`[YOUTUBE-AUTH] Safe mode exchange error: ${e.message}`);
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, { success: false, error: e.message }, obj.callback);
                        }
                    }
                } else {
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { success: false, error: 'No code provided' }, obj.callback);
                    }
                }
                break;
                
            case 'getYouTubeAuthUrl':
                const mode = obj.message && obj.message.mode || 'safe';
                const authUrl = this.generateYouTubeAuthUrl(mode);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { success: true, url: authUrl, mode: mode }, obj.callback);
                }
                break;
                
            case 'getYouTubeTokenStatus':
                try {
                    const tokenState = await this.getStateAsync('youtube_oauth_tokens');
                    let status = { connected: false, hasAccessToken: false, hasRefreshToken: false, expiryDate: null };
                    
                    if (tokenState && tokenState.val) {
                        const tokens = JSON.parse(tokenState.val);
                        status = {
                            connected: !!tokens.access_token,
                            hasAccessToken: !!tokens.access_token,
                            hasRefreshToken: !!tokens.refresh_token,
                            expiryDate: tokens.expiry_date || null,
                            isExpired: tokens.expiry_date ? Date.now() >= tokens.expiry_date : false
                        };
                    }
                    
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { success: true, status: status }, obj.callback);
                    }
                } catch (e) {
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { success: false, error: e.message }, obj.callback);
                    }
                }
                break;
                
            case 'clearYouTubeTokens':
                await this.setStateAsync('youtube_oauth_tokens', '', true);
                this.log.info('[YOUTUBE-AUTH] Cleared YouTube tokens');
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
                }
                break;
                
            default:
                this.log.warn(`[MESSAGE] Unknown command: ${obj.command}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { success: false, error: 'Unknown command' }, obj.callback);
                }
        }
    }

    /**
     * Generate YouTube OAuth URL
     * @param {string} mode - 'automatic' or 'safe'
     * @returns {string|null} OAuth URL or null if credentials missing
     */
    generateYouTubeAuthUrl(mode) {
        const creds = this.getYouTubeCredentials();
        if (!creds) {
            this.log.error('[YOUTUBE-AUTH] Cannot generate auth URL: no credentials configured');
            return null;
        }
        
        let redirectUri;
        
        if (mode === 'automatic') {
            // Use actual server IP for OAuth callback
            redirectUri = `http://${this.localIp}:${this.serverPort}/oauth/youtube`;
        } else {
            redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
        }
        
        const params = new URLSearchParams({
            access_type: 'offline',
            scope: YOUTUBE_SCOPES.join(' '),
            prompt: 'consent',
            response_type: 'code',
            client_id: creds.client_id,
            redirect_uri: redirectUri
        });
        
        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    /**
     * Exchange YouTube authorization code for tokens (Safe Mode - OOB)
     * @param {string} code - Authorization code from Google
     * @returns {object|null} Token object or null on failure
     */
    async exchangeYouTubeCodeSafeMode(code) {
        try {
            const creds = this.getYouTubeCredentials();
            if (!creds) {
                throw new Error('No valid OAuth credentials configured');
            }
            
            const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
            
            this.log.info('[YOUTUBE-AUTH] Safe mode: Exchanging code for tokens...');
            
            const oAuth2Client = new OAuth2Client(creds.client_id, creds.client_secret, redirectUri);
            const { tokens } = await oAuth2Client.getToken(code);
            
            this.log.info('[YOUTUBE-AUTH] Safe mode: Token exchange successful');
            this.log.debug(`[YOUTUBE-AUTH] Tokens: access_token=${tokens.access_token ? 'present' : 'missing'}, refresh_token=${tokens.refresh_token ? 'present' : 'missing'}`);
            
            await this.setObjectNotExistsAsync('youtube_oauth_tokens', {
                type: 'state',
                common: {
                    name: 'YouTube OAuth Tokens',
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: true,
                    desc: 'YouTube Premium OAuth tokens'
                }
            });
            await this.setStateAsync('youtube_oauth_tokens', JSON.stringify(tokens), true);
            
            await this.initPlayDl();
            
            return tokens;
        } catch (e) {
            this.log.error(`[YOUTUBE-AUTH] Safe mode exchange error: ${e.message}`);
            throw e;
        }
    }

    onUnload(callback) {
        if (this.server) this.server.close();
        if (this.mdns) this.mdns.destroy();
        callback();
    }
}

if (require.main === module) { new GoogleBroadcast(); } else { module.exports = (options) => new GoogleBroadcast(options); }
