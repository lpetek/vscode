/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AbstractConnection } from 'vs/server/connection/abstractConnection';
import { ServerProtocol } from 'vs/server/protocol';

/**
 * Used for all the IPC channels.
 */
export class ManagementConnection extends AbstractConnection {
	public constructor(protocol: ServerProtocol) {
		super(protocol, 'management');

		protocol.onDidDispose(() => this.dispose('Explicitly closed'));
		protocol.onSocketClose(() => this.setOffline()); // Might reconnect.

		protocol.sendMessage({ type: 'ok' });
	}

	protected doDispose(): void {
		this.protocol.destroy();
	}

	protected doReconnect(protocol: ServerProtocol): void {
		protocol.sendMessage({ type: 'ok' });
		this.protocol.beginAcceptReconnection(protocol.getSocket(), protocol.readEntireBuffer());
		this.protocol.endAcceptReconnection();
		protocol.dispose();
	}
}
