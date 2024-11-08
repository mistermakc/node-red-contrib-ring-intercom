import nodeRed, { NodeAPI, NodeDef } from 'node-red';
import { RingApi } from 'ring-client-api';
import { RingIntercom } from 'ring-client-api'; // Replace with the actual import path for RingIntercom
import { BehaviorSubject } from 'rxjs';

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
                                const intercomData = new BehaviorSubject(intercom.data); // Hold the latest intercom data

                                // Subscribe to ding events
                                const dingSubscription = intercom.onDing.subscribe(() => {
                                    intercomData.next(intercom.data);  // Update latest data on ding
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
                                    intercomData.next(intercom.data);  // Update latest data on unlock
                                    this.send({
                                        topic: `ring/${location.id}/intercom/${intercom.id}/unlock`,
                                        payload: {
                                            intercomData: intercom.data,
                                            message: "Intercom unlocked",
                                        },
                                    });
                                });

                                // Emit the latest data when the node subscribes
                                intercomData.subscribe((data) => {
                                    this.send({
                                        topic: `ring/${location.id}/intercom/${intercom.id}/state`,
                                        payload: {
                                            intercomData: data,
                                            message: "Latest intercom state",
                                        },
                                    });
                                });

                                // Unlock the door on input
                                this.on('input', (msg, send, done) => {
                                    if (msg.payload === 'unlock') {
                                        intercom.unlock()
                                            .then(() => {
                                                intercomData.next(intercom.data); // Update latest data on unlock command
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

                                // Clean up subscriptions
                                this.on('close', () => {
                                    dingSubscription.unsubscribe();
                                    unlockSubscription.unsubscribe();
                                    intercomData.unsubscribe();
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

    function DeviceListenerNode(this: nodeRed.Node, config: DefaultConfiguredNodeType) {
        RED.nodes.createNode(this, config);

        let configNode: RingConfigNodeType = RED.nodes.getNode(config.config) as RingConfigNodeType;
        configNode.once('ring-config-token-fetched', () => {
            if (configNode && configNode.api) {
                const api = configNode.api;

                api.getLocations().then(locations => {
                    locations.forEach((location) => {

                        const subscription = location.onDeviceDataUpdate.subscribe(deviceUpdate => {
                            location.getDevices().then(devices => {
                                let device = devices.find(d => d.id === deviceUpdate.id);

                                if (device) {
                                    this.send({
                                        topic: `ring/${location.id}/device/${device.id}`,
                                        payload: {
                                            deviceData: device.data,
                                            update: deviceUpdate,
                                        },
                                    });
                                }
                            }).catch(e => RED.log.error(e));
                        });

                        this.on('close', () => {
                            subscription.unsubscribe();
                        });
                    });

                    this.status({
                        fill: 'green',
                        text: 'connected',
                    });
                }).catch(e => {
                    this.status({
                        fill: 'red',
                        text: `Error: ${e.message}`,
                    });
                    RED.log.error(e);
                });
            } else {
                this.status({
                    fill: 'red',
                    text: 'no credentials',
                });
            }
        });
    }

    RED.nodes.registerType('Device Listener', DeviceListenerNode);
};

module.exports = init;
