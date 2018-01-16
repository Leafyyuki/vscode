/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as strings from 'vs/base/common/strings';
import { ITextBufferBuilder, DefaultEndOfLine, ITextBufferFactory, ITextBuffer } from 'vs/editor/common/model';
import { TextSource, IRawTextSource } from 'vs/editor/common/model/pieceTableTextBuffer/textSource';
import { PieceTableTextBuffer } from 'vs/editor/common/model/pieceTableTextBuffer/pieceTableTextBuffer';
import { StringBuffer } from 'vs/editor/common/model/pieceTableTextBuffer/pieceTableBase';
import { CharCode } from 'vs/base/common/charCode';

export class PieceTableTextBufferFactory implements ITextBufferFactory {

	constructor(private readonly rawTextSource: IRawTextSource) {
	}

	public create(defaultEOL: DefaultEndOfLine): ITextBuffer {
		const textSource = TextSource.fromRawTextSource(this.rawTextSource, defaultEOL);
		return new PieceTableTextBuffer(textSource);
	}

	public getFirstLineText(lengthLimit: number): string {
		return this.rawTextSource.chunks[0].buffer.substr(0, 100).split(/\r\n|\r|\n/)[0];
	}
}

class PTBasedBuilder {
	private leftoverEndsInCR: boolean;
	private chunks: StringBuffer[];
	private lineFeedCnt: number;
	private BOM: string;
	private chunkIndex: number;
	private totalCRCount: number;
	private _regex: RegExp;

	constructor() {
		this.leftoverEndsInCR = false;
		this.chunks = [];
		this.BOM = '';
		this.chunkIndex = 0;
		this.totalCRCount = 0;
		this._regex = new RegExp(/\r\n|\r|\n/g);
		this.lineFeedCnt = 0;
	}

	public acceptChunk(chunk: string): void {
		if (chunk.length === 0) {
			return;
		}

		let lineStarts = [0];
		if (this.chunkIndex === 0) {
			if (strings.startsWithUTF8BOM(chunk)) {
				this.BOM = strings.UTF8_BOM_CHARACTER;
				chunk = chunk.substr(1);
			}
		}

		if (this.leftoverEndsInCR) {
			chunk = '\r' + chunk;
		}

		if (chunk.charCodeAt(chunk.length - 1) === CharCode.CarriageReturn) {
			this.leftoverEndsInCR = true;
			chunk = chunk.substr(0, chunk.length - 1);
		} else {
			this.leftoverEndsInCR = false;
		}

		// Reset regex to search from the beginning
		this._regex.lastIndex = 0;
		let prevMatchStartIndex = -1;
		let prevMatchLength = 0;

		let m: RegExpExecArray;
		do {
			if (prevMatchStartIndex + prevMatchLength === chunk.length) {
				// Reached the end of the line
				break;
			}

			m = this._regex.exec(chunk);
			if (!m) {
				break;
			}

			const matchStartIndex = m.index;
			const matchLength = m[0].length;

			if (matchStartIndex === prevMatchStartIndex && matchLength === prevMatchLength) {
				// Exit early if the regex matches the same range twice
				break;
			}

			if (matchLength === 2 || m[0] === '\r') {
				this.totalCRCount++;
			}

			prevMatchStartIndex = matchStartIndex;
			prevMatchLength = matchLength;

			lineStarts.push(matchStartIndex + matchLength);
			this.lineFeedCnt++;
		} while (m);

		this.chunks.push(new StringBuffer(chunk, lineStarts));
		this.chunkIndex++;
	}

	public finish(containsRTL: boolean, isBasicASCII: boolean): PieceTableTextBufferFactory {
		if (this.chunks.length === 0) {
			this.chunks.push(new StringBuffer('', [0]));
		}

		if (this.leftoverEndsInCR) {
			// we don't want need to create a new chunk for this standalone \r
			let lastChunk = this.chunks[this.chunks.length - 1];
			lastChunk.buffer += '\r';
			lastChunk.lineStarts.push(lastChunk.buffer.length);
		}

		return new PieceTableTextBufferFactory({
			chunks: this.chunks,
			lineFeedCnt: this.lineFeedCnt,
			BOM: this.BOM,
			totalCRCount: this.totalCRCount,
			containsRTL: containsRTL,
			isBasicASCII: isBasicASCII
		});
	}
}

export class PieceTableTextBufferBuilder implements ITextBufferBuilder {

	private containsRTL: boolean;
	private isBasicASCII: boolean;

	private ptBasedBuilder: PTBasedBuilder;

	constructor() {
		this.containsRTL = false;
		this.isBasicASCII = true;
		this.ptBasedBuilder = new PTBasedBuilder();
	}

	public acceptChunk(chunk: string): void {
		if (chunk.length === 0) {
			return;
		}

		// update lineStart to offset mapping
		if (!this.containsRTL) {
			this.containsRTL = strings.containsRTL(chunk);
		}
		if (this.isBasicASCII) {
			this.isBasicASCII = strings.isBasicASCII(chunk);
		}

		this.ptBasedBuilder.acceptChunk(chunk);
	}

	public finish(): PieceTableTextBufferFactory {
		return this.ptBasedBuilder.finish(this.containsRTL, this.isBasicASCII);
	}
}