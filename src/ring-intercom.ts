import nodeRed, { NodeAPI, NodeDef } from 'node-red';
import { RingApi } from 'ring-client-api';
import * as fs from 'fs';
import { RingIntercom } from 'ring-client-api'; 

type RingConfigCredentialType = { initialToken: string, token: string };
type RingConfigNodeType = { api: RingApi } & nodeRed.Node<RingConfigCredentialType>;
type RingConfigConfigType = {} & NodeDef;

type DefaultConfiguredNodeType = { config: string } & NodeDef;

const init = (RED: NodeAPI) => {

    function RingConfigNode(this: RingConfigNodeType, config: RingConfigConfigType) {
        RED.nodes.createNode(this, config);
        this.setMaxListeners(0);

        const resetToken = () => {
            this.context().set('token', undefined);
        };

        const updateToken = (newToken: string) => {
            this.context().set('token', newToken);
        };

        const getToken = () => this.context().get('token') as string;

        if (!getToken() && this.credentials.initialToken) {
            updateToken(this.credentials.initialToken);
        }

        if (getToken()) {
            try {
                let tmpApi = new RingApi({ refreshToken: getToken() });

                tmpApi.getProfile().then().catch(e => {
                    RED.log.error(e);
                    resetToken();
                });

                let subscription = tmpApi.onRefreshTokenUpdated.subscribe(tokenUpdate => {
                    updateToken(tokenUpdate.newRefreshToken);
                    console.log(tokenUpdate);
                    this.api = tmpApi;
                    this.emit('ring-config-token-fetched');
                });

                this.on('close', () => {
                    subscription.unsubscribe();
                    this.api.disconnect();
                });
            } catch (e) {
                RED.log.error(e);
            }
        } else {
            RED.log.error('No Token!');
        }
    }

    RED.nodes.registerType('ring-config', RingConfigNode, {
        credentials: {
            initialToken: { type: 'text' },
            token: { type: 'text' },
        },
    });

    function RingIntercomNode(this: nodeRed.Node, config: DefaultConfiguredNodeType) {
        RED.nodes.createNode(this, config);

        let configNode: RingConfigNodeType = RED.nodes.getNode(config.config) as RingConfigNodeType;
        configNode.once('ring-config-token-fetched', () => {
            if (configNode && configNode.api) {
                const api = configNode.api;

                api.getLocations().then(locations => {
                    locations.forEach(location => {
                        location.cameras.forEach(device => {
                            if (device instanceof RingIntercom) {
                                const intercom = device as RingIntercom;

                                // Subscribe to ding events
                                const dingSubscription = intercom.onDing.subscribe(() => {
                                    this.send({
                                        topic: `ring/${location.id}/intercom/${intercom.id}/ding`,
                                        payload: {
                                            intercomData: intercom.data,
                                            message: "Intercom ding received",
                                        },
                                    });
                                });

                                // Subscribe to unlock events
                                const unlockSubscription = intercom.onUnlocked.subscribe(() => {
                                    this.send({
                                        topic: `ring/${location.id}/intercom/${intercom.id}/unlock`,
                                        payload: {
                                            intercomData: intercom.data,
                                            message: "Intercom unlocked",
                                        },
                                    });
                                });

                                // Optional: Add functionality to unlock the door
                                this.on('input', (msg, send, done) => {
                                    if (msg.payload === 'unlock') {
                                        intercom.unlock()
                                            .then(() => {
                                                this.status({
                                                    fill: 'green',
                                                    text: 'Door unlocked',
                                                });
                                                send({ payload: 'Door unlocked' });
                                                done();
                                            })
                                            .catch(e => {
                                                this.status({
                                                    fill: 'red',
                                                    text: 'Failed to unlock door',
                                                });
                                                RED.log.error(e);
                                                done(e);
                                            });
                                    }
                                });

                                // Clean up when the node is closed
                                this.on('close', () => {
                                    dingSubscription.unsubscribe();
                                    unlockSubscription.unsubscribe();
                                });
                            }
                        });
                    });

                    this.status({
                        fill: 'green',
                        text: 'connected',
                    });
                });
            } else {
                this.status({
                    fill: 'red',
                    text: 'no credentials',
                });
            }
        });
    }

    RED.nodes.registerType('Intercom', RingIntercomNode);
};

// Export the initialization function
module.exports = init;
