/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as WebSocket from 'ws';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { Event, Emitter } from 'vs/base/common/event';
import { RunOnceScheduler } from 'vs/base/common/async';
import { RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode } from 'vs/platform/remote/common/remoteAuthorityResolver';
// eslint-disable-next-line code-layering, code-import-patterns
import { IWebSocket, IWebSocketCloseEvent } from 'vs/platform/remote/browser/browserSocketFactory';
import { ISocket, SocketCloseEvent, SocketCloseEventType } from 'vs/base/parts/ipc/common/ipc.net';
import { VSBuffer } from 'vs/base/common/buffer';

/**
 * @coder Wraps server-side web socket in an interface that can be consumed
 * by `ServerSocket`. This allows IPC-style protocol handlers to interact with it.
 */
class ServerWebSocket extends Disposable implements IWebSocket {
	private readonly _onData = new Emitter<ArrayBuffer>();
	public readonly onData = this._onData.event;

	public readonly onOpen: Event<void>;

	private readonly _onClose = this._register(new Emitter<IWebSocketCloseEvent>());
	public readonly onClose = this._onClose.event;

	private readonly _onError = this._register(new Emitter<any>());
	public readonly onError = this._onError.event;

	private _isClosed = false;

	public readonly ws: WebSocket;

	private readonly _socketMessageListener = (data: Uint8Array) => {
		this._onData.fire(data);
	};

	constructor(ws: WebSocket) {
		super();
		this.ws = ws;

		this.onOpen = Event.fromNodeEventEmitter(this.ws, 'open');

		// WebSockets emit error events that do not contain any real information
		// Our only chance of getting to the root cause of an error is to
		// listen to the close event which gives out some real information:
		// - https://www.w3.org/TR/websockets/#closeevent
		// - https://tools.ietf.org/html/rfc6455#section-11.7
		//
		// But the error event is emitted before the close event, so we therefore
		// delay the error event processing in the hope of receiving a close event
		// with more information

		let pendingErrorEvent: any | null = null;

		const sendPendingErrorNow = () => {
			const err = pendingErrorEvent;
			pendingErrorEvent = null;
			this._onError.fire(err);
		};

		const errorRunner = this._register(new RunOnceScheduler(sendPendingErrorNow, 0));

		const sendErrorSoon = (err: any) => {
			errorRunner.cancel();
			pendingErrorEvent = err;
			errorRunner.schedule();
		};

		const sendErrorNow = (err: any) => {
			errorRunner.cancel();
			pendingErrorEvent = err;
			sendPendingErrorNow();
		};

		this.ws.on('message', this._socketMessageListener);

		this.ws.addEventListener('close', (e) => {
			this._isClosed = true;

			if (pendingErrorEvent) {
				// An error event is pending
				// The browser appears to be online...
				if (!e.wasClean) {
					// Let's be optimistic and hope that perhaps the server could not be reached or something
					sendErrorNow(new RemoteAuthorityResolverError(e.reason || `WebSocket close with status code ${e.code}`, RemoteAuthorityResolverErrorCode.TemporarilyNotAvailable, e));
				} else {
					// this was a clean close => send existing error
					errorRunner.cancel();
					sendPendingErrorNow();
				}
			}

			this._onClose.fire({ code: e.code, reason: e.reason, wasClean: e.wasClean, event: e });
		});

		this.ws.addEventListener('error', sendErrorSoon);
	}

	send(data: ArrayBuffer | ArrayBufferView): void {
		if (this._isClosed) {
			// Refuse to write data to closed WebSocket...
			return;
		}
		this.ws.send(data);
	}

	close(): void {
		this._isClosed = true;
		this.ws.close();
		this.ws.removeAllListeners();
		this.dispose();
	}
}

export class ServerSocket implements ISocket {
	public readonly socket: net.Socket;
	public readonly ws: ServerWebSocket;

	constructor(ws: WebSocket, socket: net.Socket) {
		this.ws = new ServerWebSocket(ws);
		this.socket = socket;
	}

	public dispose(): void {
		this.ws.close();
	}

	public onData(listener: (e: VSBuffer) => void): IDisposable {
		return this.ws.onData((data) => listener(VSBuffer.wrap(new Uint8Array(data))));
	}

	public onClose(listener: (e: SocketCloseEvent) => void): IDisposable {
		const adapter = (e: IWebSocketCloseEvent | void) => {
			if (typeof e === 'undefined') {
				listener(e);
			} else {
				console.log('SERVER CLOSE');
				listener({
					type: SocketCloseEventType.WebSocketCloseEvent,
					code: e.code,
					reason: e.reason || getStatusCodeLabel(e.code),
					wasClean: e.wasClean,
					event: e.event
				});
			}
		};

		return this.ws.onClose(adapter);
	}

	public onEnd(listener: () => void): IDisposable {
		return Disposable.None;
	}

	public write(buffer: VSBuffer): void {
		this.ws.send(buffer.buffer);
	}

	public end(): void {
		this.ws.close();
	}

	public drain(): Promise<void> {
		return Promise.resolve();
	}
}

const specificStatusCodeMappings: { [code: string]: string | undefined } = {
	'1000': 'Normal Closure',
	'1001': 'Going Away',
	'1002': 'Protocol Error',
	'1003': 'Unsupported Data',
	'1004': '(For future)',
	'1005': 'No Status Received',
	'1006': 'Abnormal Closure',
	'1007': 'Invalid frame payload data',
	'1008': 'Policy Violation',
	'1009': 'Message too big',
	'1010': 'Missing Extension',
	'1011': 'Internal Error',
	'1012': 'Service Restart',
	'1013': 'Try Again Later',
	'1014': 'Bad Gateway',
	'1015': 'TLS Handshake'
};

function getStatusCodeLabel(code: number) {
	if (code >= 0 && code <= 999) {
		return '(Unused)';
	} else if (code >= 1016) {
		if (code <= 1999) {
			return '(For WebSocket standard)';
		} else if (code <= 2999) {
			return '(For WebSocket extensions)';
		} else if (code <= 3999) {
			return '(For libraries and frameworks)';
		} else if (code <= 4999) {
			return '(For applications)';
		}
	}

	return specificStatusCodeMappings[code] || '(Unknown)';
}
