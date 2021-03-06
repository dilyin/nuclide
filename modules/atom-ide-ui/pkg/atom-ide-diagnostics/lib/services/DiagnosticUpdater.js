/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow strict-local
 * @format
 */

import type {
  AppState,
  CodeActionsState,
  DescriptionsState,
  DiagnosticMessage,
  DiagnosticMessages,
  DiagnosticMessageKind,
  Store,
  UiConfig,
} from '../types';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';

import {throttle} from 'nuclide-commons/observable';
import * as Actions from '../redux/Actions';
import * as Selectors from '../redux/Selectors';
import observableFromReduxStore from 'nuclide-commons/observableFromReduxStore';
import {arrayEqual} from 'nuclide-commons/collection';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {Observable} from 'rxjs';

const THROTTLE_FILE_MESSAGE_MS = 100;

export default class DiagnosticUpdater {
  _store: Store;
  _states: Observable<AppState>;
  _allMessageUpdates: Observable<Array<DiagnosticMessage>>;

  constructor(store: Store) {
    this._store = store;
    this._states = observableFromReduxStore(store);

    this._allMessageUpdates = this._states
      .map(Selectors.getMessages)
      .distinctUntilChanged();
  }

  getMessages = (): Array<DiagnosticMessage> => {
    return Selectors.getMessages(this._store.getState());
  };

  getFileMessageUpdates = (filePath: NuclideUri): DiagnosticMessages => {
    return Selectors.getFileMessageUpdates(this._store.getState(), filePath);
  };

  observeMessages = (
    callback: (messages: Array<DiagnosticMessage>) => mixed,
  ): IDisposable => {
    return new UniversalDisposable(this._allMessageUpdates.subscribe(callback));
  };

  observeFileMessagesIterator = (
    filePath: NuclideUri,
    callback: (update: Iterable<DiagnosticMessage>) => mixed,
  ): IDisposable => {
    return new UniversalDisposable(
      this._states
        .distinctUntilChanged((a, b) => a.messages === b.messages)
        .let(throttle(THROTTLE_FILE_MESSAGE_MS))
        .map(state => ({
          [Symbol.iterator]() {
            return Selectors.getBoundedThreadedFileMessages(state, filePath);
          },
        }))
        // $FlowFixMe Flow doesn't know about Symbol.iterator
        .subscribe(callback),
    );
  };

  observeFileMessages = (
    filePath: NuclideUri,
    callback: (update: DiagnosticMessages) => mixed,
  ): IDisposable => {
    return new UniversalDisposable(
      // TODO: As a potential perf improvement, we could cache so the mapping only happens once.
      // Whether that's worth it depends on how often this is actually called with the same path.
      this._states
        .distinctUntilChanged((a, b) => a.messages === b.messages)
        .let(throttle(THROTTLE_FILE_MESSAGE_MS))
        .map(state => Selectors.getFileMessageUpdates(state, filePath))
        .distinctUntilChanged(
          (a, b) =>
            a.totalMessages === b.totalMessages &&
            arrayEqual(a.messages, b.messages),
        )
        .subscribe(callback),
    );
  };

  observeCodeActionsForMessage = (
    callback: (update: CodeActionsState) => mixed,
  ): IDisposable => {
    return new UniversalDisposable(
      this._states
        .map(state => state.codeActionsForMessage)
        .distinctUntilChanged()
        .subscribe(callback),
    );
  };

  observeDescriptions = (
    callback: (update: DescriptionsState) => mixed,
  ): IDisposable => {
    return new UniversalDisposable(
      this._states
        .map(state => state.descriptions)
        .distinctUntilChanged()
        .subscribe(callback),
    );
  };

  observeSupportedMessageKinds = (
    callback: (kinds: Set<DiagnosticMessageKind>) => mixed,
  ): IDisposable => {
    return new UniversalDisposable(
      this._states.map(Selectors.getSupportedMessageKinds).subscribe(callback),
    );
  };

  observeUiConfig = (callback: (config: UiConfig) => mixed): IDisposable => {
    return new UniversalDisposable(
      this._states
        .map(Selectors.getUiConfig)
        // Being a selector means we'll always get the same ui config for a given
        // slice of state (in this case `state.providers`). However, other parts
        // of state may change. Don't emit in those cases, or in the common case
        // that the config changed from an empty array to a different empty array.
        .distinctUntilChanged(
          (a, b) => a === b || (a.length === 0 && b.length === 0),
        )
        .subscribe(callback),
    );
  };

  applyFix = (message: DiagnosticMessage): void => {
    this._store.dispatch(Actions.applyFix(message));
  };

  applyFixesForFile = (file: NuclideUri): void => {
    this._store.dispatch(Actions.applyFixesForFile(file));
  };

  fetchCodeActions = (
    editor: atom$TextEditor,
    messages: Array<DiagnosticMessage>,
  ): void => {
    this._store.dispatch(Actions.fetchCodeActions(editor, messages));
  };

  fetchDescriptions = (messages: Array<DiagnosticMessage>): void => {
    this._store.dispatch(Actions.fetchDescriptions(messages));
  };
}
