    /**
     * Send text command to Assistant
     */
    sendBroadcast(textCommand) {
        if (!this.assistant) {
            this.log.error('Assistant not initialized. Cannot broadcast.');
            return;
        }

        const config = {
            conversation: {
                textQuery: textCommand,
                isNew: true,
                deviceModelId: this.config.deviceModelId,
                deviceLocation: {
                    coordinates: {
                        latitude: 0,
                        longitude: 0
                    }
                }
            }
        };

        this.log.debug(`Sending command to Google: "${textCommand}"`);

        // v0.7.0 robustness: Ensure we catch startup errors immediately
        try {
            this.assistant.start(config.conversation, (conversation) => {
                // This callback receives the conversation object
                conversation
                    .on('audio-data', (data) => {
                        // Optional: Handle audio response if you want to save the "OK, broadcasting" speech
                    })
                    .on('end-of-utterance', () => {
                        this.log.debug('Google Assistant: End of utterance');
                    })
                    .on('transcription', (data) => {
                        this.log.debug('Google Transcription: ' + (data.transcription || data));
                    })
                    .on('response', (text) => {
                        if (text) this.log.debug('Google Text Response: ' + text);
                    })
                    .on('volume-percent', (percent) => {
                        // Ignore volume changes during broadcast
                    })
                    .on('device-action', (action) => {
                        // Ignore device actions
                    })
                    .on('ended', (error, continueConversation) => {
                        if (error) {
                            this.log.error('Broadcast Conversation Ended with Error: ' + error);
                        } else {
                            this.log.debug('Broadcast conversation finished successfully.');
                        }
                    })
                    .on('error', (error) => {
                        this.log.error('Broadcast Conversation Error: ' + error);
                    });
            });
        } catch (error) {
            this.log.error(`Failed to start conversation: ${error}`);
        }
    }