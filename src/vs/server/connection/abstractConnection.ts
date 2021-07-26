/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { ConsoleLogger } from 'vs/platform/log/common/log';
import { ServerProtocol } from 'vs/server/protocol';

export abstract class AbstractConnection {
	private readonly _onClose = new Emitter<void>();
	/**
	 * Fire when the connection is closed (not just disconnected). This should
	 * only happen when the connection is offline and old or has an error.
	 */
	public readonly onClose = this._onClose.event;
	private disposed = false;
	private _offline: number | undefined;

	protected readonly logger: ConsoleLogger;

	public constructor(
		protected readonly protocol: ServerProtocol,
		public readonly name: string,
	) {
		this.logger = new ConsoleLogger();

		this.logger.debug('Connecting...');
		this.onClose(() => this.logger.debug('Closed'));
	}

	public get offline(): number | undefined {
		return this._offline;
	}

	public reconnect(protocol: ServerProtocol): void {
		this.logger.debug(`${this.protocol.reconnectionToken} Reconnecting...`);
		this._offline = undefined;
		this.doReconnect(protocol);
	}

	public dispose(reason?: string): void {
		this.logger.debug(`${this.protocol.reconnectionToken} Disposing...`, reason);
		if (!this.disposed) {
			this.disposed = true;
			this.doDispose();
			this._onClose.fire();
		}
	}

	protected setOffline(): void {
		this.logger.debug('Disconnected');
		if (!this._offline) {
			this._offline = Date.now();
		}
	}

	/**
	 * Set up the connection on a new socket.
	 */
	protected abstract doReconnect(protcol: ServerProtocol): void;

	/**
	 * Dispose/destroy everything permanently.
	 */
	protected abstract doDispose(): void;
}
