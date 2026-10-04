/**
 * Browser half of `dsh-bgm`.
 *
 * Contributes TWO entries, and the split between them is the whole design:
 *
 * 1. **The settings row** (`settings.general.item`, order 110) holds the folder
 *    input and the transport buttons. It sits directly below "当前版本：0.2.0-rc.2"
 *    (the shipped rows end at `current-version`, order 100), so it stays where it
 *    was, and it still owns no copy of the music folder: that value lives in the
 *    Host's settings document for this plugin's entry and is read/written through
 *    `ctx.configForms`.
 *
 * 2. **The player** (`shell.overlay`) owns the ONE `<audio>` element.
 *
 * The second half exists because of a bug the first version had: the row owned the
 * audio element, so closing the Settings page unmounted the row and killed
 * playback. A music player must outlive the surface that configures it.
 * `settings.general.item` only exists while the Settings panel is open;
 * `shell.overlay` is the frame-wide floating layer, outside every panel's scroll
 * container and above the whole grid, so an entry there survives closing Settings,
 * switching Sessions and switching panels.
 *
 * The two entries talk through ONE shared store (`createPlaybackStore`), cached on
 * `globalThis` so a client-HMR re-evaluation reuses the live element instead of
 * stranding a second, silent one. A React context could not do this job: the row
 * and the overlay are mounted by different owners, and this plugin controls
 * neither of their trees.
 *
 * Loaded by client-modules as `window.__ModuleLoader__.load({ id, factory })`,
 * where `require` resolves the platform's own externals (`react`,
 * `react/jsx-runtime`) and never a filesystem path.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bgm',

  factory: function (require) {
    const React = require('react')

    /** The settings row: one preference row inside the General section. */
    const ROW_SLOT = 'settings.general.item'
    /** This row's cell key. A fresh id is added beside the shipped entries. */
    const ROW_ID = 'dsh-bgm-folder'
    /** Position among the General rows: after `current-version` (order 100). */
    const ROW_ORDER = 110
    /** The frame-wide floating layer: an entry here outlives every panel. */
    const OVERLAY_SLOT = 'shell.overlay'
    /** The overlay entry's cell key. */
    const OVERLAY_ID = 'dsh-bgm-player'
    /** This plugin's settings entry id — the `- insert: id:` in cordis.patch.yml. */
    const SETTINGS_NAMESPACE = 'dsh-bgm'
    /** Dictionary namespace owned by this plugin. */
    const LOCALE_NS = 'dshBgm'
    /** Where the Host half serves the library manifest. */
    const MANIFEST = '/plugins/dsh-bgm/manifest.json'
    /** Key the single store instance is cached under. */
    const STORE_KEY = '__dshBgmPlaybackStore__'
    /**
     * How long a library listing is trusted before it is re-read.
     *
     * Short on purpose: the folder's contents are owned by the filesystem, not by
     * this plugin, so a deleted file can only be noticed by asking again. Fifteen
     * seconds is long enough that it is not a poll and short enough that a deletion
     * does not keep playing for minutes.
     */
    const LIBRARY_TTL_MS = 15000

    /** Text shown when the active locale has no entry for a key. */
    const DICTIONARY_ZH = {
      title: '背景音乐文件夹',
      description: '指定一个音乐文件夹，对话时自动播放其中的音乐',
      placeholder: '例如 A:\\Music，留空则不播放',
      browse: '浏览…',
      play: '播放',
      pause: '暂停',
      next: '下一首',
      volume: '音量',
      tracks: '{count} 首',
      loading: '读取中…',
      empty: '这个文件夹里没有可播放的音频',
      unset: '还没有指定文件夹',
      unusable: '这个文件夹不存在或无法读取',
      readFailed: '读取文件夹失败',
      disabled: '已关闭播放',
      now: '正在播放：{name}',
      enable: '播放背景音乐',
      dragHint: '拖动可移动到任意位置',
    }

    const DICTIONARY_EN = {
      title: 'Background music folder',
      description: 'Pick a music folder to play from while you chat',
      placeholder: 'e.g. A:\\Music — leave empty to stay silent',
      browse: 'Browse…',
      play: 'Play',
      pause: 'Pause',
      next: 'Next',
      volume: 'Volume',
      tracks: '{count} tracks',
      loading: 'Loading…',
      empty: 'No playable audio in this folder',
      unset: 'No folder selected yet',
      unusable: 'That folder is missing or unreadable',
      readFailed: 'Could not read the folder',
      disabled: 'Playback is off',
      now: 'Playing: {name}',
      enable: 'Play background music',
      dragHint: 'Drag to move anywhere',
    }

    /**
     * Narrow the optional service table by method shape.
     *
     * Every service this half needs is read through here rather than declared in
     * `inject`, because a declared-but-missing service parks the whole fiber: a
     * deployment whose settings provider has not activated yet would lose the row
     * entirely instead of picking it up when it arrives.
     * @param owner - the injected context.
     * @param name - service key.
     * @returns the service, or undefined when absent or not yet provided.
     */
    function serviceAt(owner, name) {
      const value = owner.get(name)
      return value === null || value === undefined ? undefined : value
    }

    /** Interpolate `{key}` placeholders in one dictionary string. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      )
    }

    /** Build a translator bound to this plugin's dictionary namespace. */
    function translator(owner) {
      const fallback = function (key, values) {
        const template = DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key]
        return values === undefined ? template : format(template, values)
      }
      if (owner === undefined) return fallback
      const locale = serviceAt(owner, 'locale')
      if (locale === undefined || typeof locale.bind !== 'function') return fallback
      const bound = locale.bind(LOCALE_NS)
      return function (key, values) {
        const template = bound(key)
        // `bind` answers the key itself when the dictionary has no entry.
        const text = template === key ? (DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key]) : template
        return values === undefined ? text : format(text, values)
      }
    }

    /**
     * The settings scope for this plugin's entry, re-read on every call.
     *
     * A thin live view on purpose: `configForms` may activate after this plugin's
     * `apply` runs, and re-asking lets a late arrival reach a row that is already
     * mounted.
     * @param owner - the injected context.
     * @returns the form scope, or undefined while the Host serves nothing.
     */
    function formFor(owner) {
      const forms = serviceAt(owner, 'configForms')
      if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined
      const scope = forms.get(SETTINGS_NAMESPACE)
      return scope === undefined ? undefined : scope
    }

    /**
     * The playback store: the single owner of "what is playing".
     *
     * It is deliberately NOT React state. React state cannot be shared between two
     * components mounted by different owners, and a context would need a provider
     * above both — which this plugin does not control. A tiny observable with
     * `subscribe`/`getSnapshot` is exactly the shape `useSyncExternalStore` wants
     * and needs no provider at all.
     */
    function createPlaybackStore() {
      let snapshot = {
        folder: '',
        enabled: true,
        volume: 0.5,
        tracks: [],
        libraryError: null,
        loading: false,
        index: -1,
        playing: false,
      }
      const listeners = new Set()
      /** The element, once the overlay has mounted and registered it. */
      let audio = null
      /** When the library was last read successfully; 0 means never. */
      let lastLoadedAt = 0

      const emit = (patch) => {
        const next = Object.assign({}, snapshot, patch)
        let changed = false
        for (const key of Object.keys(next)) {
          if (next[key] !== snapshot[key]) {
            changed = true
            break
          }
        }
        if (!changed) return
        snapshot = next
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.warn('dsh-bgm: playback listener threw', error)
          }
        }
      }

      const currentTrack = () => {
        const tracks = snapshot.tracks
        if (tracks.length === 0) return undefined
        return tracks[(snapshot.index < 0 ? 0 : snapshot.index) % tracks.length]
      }

      /** Reconcile the one media element with the current state. */
      const applyToElement = () => {
        if (audio === null) return
        const track = currentTrack()
        if (!snapshot.enabled || track === undefined) {
          audio.pause()
          if (snapshot.playing) emit({ playing: false })
          return
        }
        if (audio.getAttribute('src') !== track.src) audio.setAttribute('src', track.src)
        audio.volume = Math.max(0, Math.min(1, snapshot.volume))
        if (!snapshot.playing) {
          audio.pause()
          return
        }
        const attempt = audio.play()
        if (attempt !== undefined && typeof attempt.catch === 'function') {
          // Autoplay is gated on a user gesture by every modern engine. A refusal
          // is not worth surfacing: it leaves the button unpressed, and the next
          // real click succeeds because that click IS the gesture.
          attempt.catch(() => emit({ playing: false }))
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        currentTrack,

        /** Merge a patch into the state and reconcile the element. */
        set(patch) {
          emit(patch)
          applyToElement()
        },

        /**
         * Adopt the settings document.
         *
         * The track list is re-fetched when the folder changes, because the Host
         * is the only thing that can say what a folder actually contains.
         */
        adoptSettings(stored) {
          const value = stored && typeof stored === 'object' ? stored : {}
          const folder = typeof value.folder === 'string' ? value.folder : ''
          const enabled = value.enabled !== false
          const volume = typeof value.volume === 'number' ? value.volume : 0.5
          const folderChanged = folder !== snapshot.folder
          emit(Object.assign({ folder, enabled, volume }, folderChanged ? { index: -1 } : {}))
          applyToElement()
          if (folderChanged) void this.reload()
        },

        /** Re-read the library manifest from the Host. */
        async reload() {
          emit({ loading: true })
          try {
            const response = await fetch(MANIFEST, { cache: 'no-store' })
            const payload = response.ok ? await response.json() : { tracks: [], error: 'READ_FAILED' }
            const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
            const previous = currentTrack()

            // Carry the selection across the refresh BY NAME when possible. The
            // index is not stable: deleting an earlier file shifts every later one,
            // so keeping the index would silently switch the user to a different
            // song.
            let index = -1
            if (tracks.length > 0) {
              const named = previous === undefined ? -1 : tracks.findIndex((entry) => entry.name === previous.name)
              index = named >= 0 ? named : snapshot.index < 0 ? 0 : snapshot.index % tracks.length
            }

            // If the track that was playing is gone, playback stops rather than
            // sliding onto whatever now occupies that slot. Continuing would be the
            // "deleted music is still playing" behaviour, just with a new song.
            const lostCurrent = previous !== undefined && !tracks.some((entry) => entry.name === previous.name)
            const stillPlaying = snapshot.playing && !lostCurrent && tracks.length > 0

            lastLoadedAt = Date.now()
            emit({
              tracks,
              libraryError: payload.error === undefined ? null : payload.error,
              loading: false,
              index,
              playing: stillPlaying,
            })
          } catch (error) {
            emit({ tracks: [], libraryError: 'READ_FAILED', loading: false, index: -1, detail: String(error) })
          }
          applyToElement()
        },

        /** Toggle play/pause. Called only from a real user gesture. */
        toggle() {
          emit({ playing: !snapshot.playing })
          applyToElement()
        },

        /** Advance to the next track, starting playback. */
        next() {
          const tracks = snapshot.tracks
          const index = tracks.length === 0 ? -1 : ((snapshot.index < 0 ? 0 : snapshot.index) + 1) % tracks.length
          emit({ index, playing: tracks.length > 0 })
          applyToElement()
        },

        /**
         * Re-read the library if the last read is older than {@link LIBRARY_TTL_MS}.
         *
         * The manifest is the Host's answer about what the folder contains NOW, and
         * a folder's contents change without anything this plugin can observe: the
         * user deletes a file in Explorer, or adds one, and no setting changes. A
         * browser that only refetched on a folder change would keep offering — and
         * keep PLAYING — tracks that no longer exist, which is exactly the report
         * that prompted this. A short TTL bounds how long that staleness can last
         * without polling the Host on every render.
         */
        refreshIfStale() {
          const age = Date.now() - lastLoadedAt
          if (lastLoadedAt !== 0 && age < LIBRARY_TTL_MS) return
          void this.reload()
        },

        /** Called by the overlay with its element once mounted. */
        attach(element) {
          audio = element
          applyToElement()
          return () => {
            if (audio === element) audio = null
          }
        },
      }
    }

    /**
     * The single store for this page.
     *
     * Cached on `globalThis` rather than module scope: a client-plugin HMR pass
     * re-evaluates the bundle, and a fresh module-scope store would leave the
     * already-mounted overlay holding the old one — playback would keep running
     * while the settings row talked to a store nobody was listening to.
     */
    function playbackStore() {
      const existing = globalThis[STORE_KEY]
      if (existing !== undefined && existing !== null) return existing
      const created = createPlaybackStore()
      globalThis[STORE_KEY] = created
      return created
    }

    /** Subscribe a component to the shared store. */
    function usePlayback(store) {
      return React.useSyncExternalStore(
        React.useCallback((notify) => store.subscribe(notify), [store]),
        React.useCallback(() => store.getSnapshot(), [store]),
      )
    }

    /** The status line's text for one store state. */
    function statusText(state, t) {
      if (!state.enabled) return t('disabled')
      if (state.loading && state.tracks.length === 0) return t('loading')
      if (state.libraryError === 'FOLDER_UNSET') return t('unset')
      if (state.libraryError === 'FOLDER_UNUSABLE') return t('unusable')
      if (state.libraryError !== null && state.libraryError !== undefined) return t('readFailed')
      if (state.tracks.length === 0) return t('empty')
      const track = state.tracks[(state.index < 0 ? 0 : state.index) % state.tracks.length]
      return track === undefined ? t('empty') : t('now', { name: track.name })
    }

    /** `{ font: inherit, … }` button styling shared by both surfaces. */
    const buttonStyle = {
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
      padding: '4px 10px',
      cursor: 'pointer',
    }

    /** Style one button, dimmed when it cannot act. */
    function buttonStyleFor(disabled) {
      return Object.assign({}, buttonStyle, { opacity: disabled ? '0.5' : '1' })
    }

    /**
     * The transport controls, shared by the settings row and the overlay.
     *
     * One component for both surfaces on purpose: the two must never disagree about
     * what "next" or "pause" means, and this is what guarantees that.
     *
     * @param props.state - the store snapshot.
     * @param props.store - the store, for actions.
     * @param props.t - translator.
     * @param props.compact - the overlay drops the volume slider and the switch.
     */
    function Transport(props) {
      const { state, store, t, compact } = props
      const hasTrack = state.tracks.length > 0 && state.enabled
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: !hasTrack,
            title: state.playing ? t('pause') : t('play'),
            'aria-label': state.playing ? t('pause') : t('play'),
            onClick: () => store.toggle(),
            style: buttonStyleFor(!hasTrack),
          },
          state.playing ? t('pause') : t('play'),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: !hasTrack || state.tracks.length < 2,
            title: t('next'),
            'aria-label': t('next'),
            onClick: () => store.next(),
            style: buttonStyleFor(!hasTrack || state.tracks.length < 2),
          },
          t('next'),
        ),
        compact
          ? null
          : React.createElement('input', {
              type: 'range',
              min: '0',
              max: '1',
              step: '0.01',
              value: String(state.volume),
              'aria-label': t('volume'),
              disabled: !state.enabled,
              onChange: () => {},
              onInput: () => {},
              readOnly: true,
            }),
      )
    }

    /**
     * The settings row: the folder input, plus transport controls.
     *
     * It no longer owns playback. It reads the shared store and asks it for
     * changes, so closing this page leaves the music running.
     *
     * @param props.owner - the injected client context, supplied by the wrapper
     *   `apply` registers. Passed as a prop because this component is mounted by
     *   the settings page, outside any provider this plugin could declare.
     * @param props.store - the shared playback store.
     */
    function BgmRow(props) {
      const owner = props === undefined ? undefined : props.owner
      const store = props === undefined ? undefined : props.store
      const scope = owner === undefined ? undefined : formFor(owner)
      const state = usePlayback(store)
      const t = React.useMemo(() => translator(owner), [owner])

      const storedValue = React.useSyncExternalStore(
        React.useCallback(
          (notify) =>
            scope !== undefined && typeof scope.subscribe === 'function'
              ? scope.subscribe(notify)
              : function () {
                  return undefined
                },
          [scope],
        ),
        React.useCallback(
          () =>
            scope !== undefined && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined,
          [scope],
        ),
      )
      const snapshot = storedValue === undefined ? undefined : storedValue
      const stored = (snapshot && snapshot.value) || {}
      const folder = typeof stored.folder === 'string' ? stored.folder : ''

      // Feed the settings document into the shared store. This is the ONLY place
      // the store learns the user's configuration, and it must run from the row
      // because the row is what has the settings scope. When the page is closed
      // the store simply keeps its last value, which is what lets playback
      // continue with no UI on screen at all.
      React.useEffect(() => {
        store.adoptSettings(stored)
      }, [store, folder, stored.enabled, stored.volume])

      // The input is a draft until committed: typing a path one character at a
      // time must not write the document on every keystroke.
      //
      // The draft starts as `null`, meaning "no draft yet", rather than as
      // `folder`. `useState(folder)` looks equivalent and is not: on the first
      // render the settings document has often not arrived, so `folder` is `''`
      // and the initializer would freeze that empty string into state — and the
      // effect below could not repair it either, because on that same render
      // `folder` is still `''`.
      const [draft, setDraft] = React.useState(null)
      const [focused, setFocused] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const folderRef = React.useRef(folder)
      folderRef.current = folder

      /** What the box shows: the user's own draft, else the stored folder. */
      const shown = draft === null ? folder : draft

      React.useEffect(() => {
        if (focused) return
        setDraft((current) => (current === null || current === folder ? null : current))
      }, [folder, focused])

      /**
       * Stage one field write.
       *
       * The operation is the settings service's own path-op shape — one atomic
       * `set`. It carries the snapshot revision, because the Host refuses a
       * mutation composed against a document it has since replaced and reports
       * that refusal as a bare `false`; a refusal is therefore retried once
       * unfenced through the remote service, which is the only way to learn WHY.
       * A control must never silently do nothing.
       */
      const write = React.useCallback(
        (field, value) => {
          const form = formFor(owner)
          if (form === undefined || typeof form.mutate !== 'function') {
            setFailure(t('readFailed'))
            return
          }
          setBusy(true)
          setFailure(null)
          const revision = snapshot === undefined || snapshot === null ? undefined : snapshot.revision
          const ops = [{ op: 'set', path: [field], value }]
          Promise.resolve(form.mutate(ops, revision))
            .then(async (accepted) => {
              if (accepted !== false) return
              if (typeof form.remoteMutate !== 'function') {
                setFailure(t('readFailed'))
                return
              }
              try {
                const answer = await form.remoteMutate(SETTINGS_NAMESPACE, ops, undefined)
                if (answer !== null && typeof answer === 'object' && answer.ok === false) {
                  const reason =
                    answer.error === undefined || answer.error === null
                      ? t('readFailed')
                      : String(answer.error.message ?? answer.error)
                  setFailure(reason)
                } else {
                  setFailure(t('readFailed'))
                }
              } catch (error) {
                setFailure(String(error))
              }
            })
            .catch((error) => setFailure(String(error)))
            .then(() => setBusy(false))
        },
        [owner, snapshot, t],
      )

      const commitFolder = React.useCallback(() => {
        if (draft === null || draft === folderRef.current) return
        write('folder', draft)
      }, [draft, write])

      const browse = React.useCallback(async () => {
        const workspace = serviceAt(owner, 'uiWorkspace')
        if (workspace === undefined || typeof workspace.pickDirectory !== 'function') return
        try {
          const picked = await workspace.pickDirectory()
          if (typeof picked === 'string' && picked !== '') {
            setDraft(picked)
            write('folder', picked)
          }
        } catch (error) {
          setFailure(String(error))
        }
      }, [owner, write])

      const onKeyDown = React.useCallback(
        (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitFolder()
          }
        },
        [commitFolder],
      )

      // The shipped General rows use this two-column rhythm: a left block carrying
      // the label and its description, and a right block carrying the control.
      return React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '16px', padding: '12px 0' } },

        React.createElement(
          'div',
          { style: { flex: '1 1 auto', minWidth: '0' } },
          React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px' } },
            t('title'),
          ),
          React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px', marginTop: '2px' } },
            t('description'),
          ),
          React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px', marginTop: '4px' } },
            statusText(state, t),
          ),
          state.tracks.length > 0
            ? React.createElement(
                'div',
                { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' } },
                t('tracks', { count: state.tracks.length }),
              )
            : null,
          failure === null
            ? null
            : React.createElement(
                'div',
                { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px', marginTop: '4px' } },
                failure,
              ),
        ),

        React.createElement(
          'div',
          { style: { flex: '0 1 auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } },

          // The folder input itself — the control this plugin was asked for.
          React.createElement('input', {
            type: 'text',
            value: shown,
            placeholder: t('placeholder'),
            spellCheck: false,
            'aria-label': t('title'),
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onFocus: () => setFocused(true),
            onBlur: () => {
              setFocused(false)
              commitFolder()
            },
            onKeyDown,
            style: {
              font: 'inherit',
              width: '260px',
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: '6px',
              padding: '5px 8px',
            },
          }),

          React.createElement(
            'button',
            { type: 'button', onClick: browse, disabled: busy, style: buttonStyle },
            t('browse'),
          ),

          React.createElement(Transport, { state, store, t }),

          React.createElement(
            'input',
            {
              type: 'range',
              min: '0',
              max: '1',
              step: '0.01',
              value: String(state.volume),
              'aria-label': t('volume'),
              disabled: !state.enabled,
              onChange: (event) => write('volume', Number(event.target.value)),
              style: { width: '88px' },
            },
          ),

          React.createElement(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: state.enabled,
              onChange: (event) => write('enabled', event.target.checked),
            }),
            t('enable'),
          ),
        ),
      )
    }

    /** Distance a press may travel before it counts as a drag rather than a click. */
    const DRAG_THRESHOLD = 4

    /**
     * Where the floating chip remembers being put.
     *
     * Kept in `localStorage`, not in the playback store: the store's job is "what
     * is playing", and this is a UI preference that must survive a reload even
     * when nothing is playing. Reading is defensive — `localStorage` throws in a
     * sandboxed frame and can hold anything a previous version wrote, and a bad
     * value must never stop the player from rendering.
     */
    const POSITION_KEY = 'dsh-bgm:chip-position'

    /** Read the remembered chip position, or undefined. */
    function readPosition() {
      try {
        const raw = globalThis.localStorage?.getItem(POSITION_KEY)
        if (typeof raw !== 'string' || raw === '') return undefined
        const parsed = JSON.parse(raw)
        // `x`/`y` are the chip's top-left corner in CLIENT coordinates.
        if (parsed === null || typeof parsed !== 'object') return undefined
        if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return undefined
        if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return undefined
        return { x: parsed.x, y: parsed.y }
      } catch (error) {
        return undefined
      }
    }

    /** Remember the chip position. A failure here is never fatal. */
    function writePosition(position) {
      try {
        globalThis.localStorage?.setItem(POSITION_KEY, JSON.stringify(position))
      } catch (error) {
        /* private mode or a sandboxed frame: the chip simply forgets */
      }
    }

    /**
     * Clamp a chip position so it stays fully on screen.
     *
     * Applied on every move and when the window resizes, because the window can
     * shrink (or the stored position can come from a much larger display) and a
     * chip dragged off the edge would be unreachable — there is no other control
     * that can bring it back.
     *
     * @param position - the desired top-left corner.
     * @param rect - the chip's measured box, when known; `width`/`height` are read
     *   from it. Absent means the fallback size is used.
     * @returns the closest on-screen position.
     */
    function clampPosition(position, rect) {
      const width = rect !== undefined && rect !== null && rect.width > 0 ? rect.width : 200
      const height = rect !== undefined && rect !== null && rect.height > 0 ? rect.height : 36
      // Read the viewport per call rather than caching it: the window resizes.
      const maxX = Math.max(0, (globalThis.innerWidth ?? 0) - width)
      const maxY = Math.max(0, (globalThis.innerHeight ?? 0) - height)
      return {
        x: Math.min(Math.max(0, position.x), maxX),
        y: Math.min(Math.max(0, position.y), maxY),
      }
    }

    /**
     * Drag behaviour for a floating chip.
     *
     * Written against pointer events rather than mouse events, because they cover
     * mouse, touch and pen with one code path and — crucially — support
     * `setPointerCapture`, which keeps the drag alive when the cursor moves faster
     * than React re-renders or leaves the element. A mousemove-on-window version
     * would drop the chip whenever the pointer outran the handler.
     *
     * A drag is distinguished from a click by distance, not by duration: the user
     * must still be able to press a button inside the chip, so a press that never
     * moves more than {@link DRAG_THRESHOLD} pixels is left alone.
     *
     * The chip's corner is read from its OWN rendered rectangle on press, not from
     * `position`. That matters for the very first drag: while unplaced, `position`
     * is null and the chip is pinned by `right`/`bottom`, so its real corner is
     * wherever the viewport put it. Assuming `{0, 0}` there would compute a grab
     * offset of the full pointer distance and snap the chip to the top-left corner
     * on the first move.
     *
     * @param props.position - current top-left corner, or null while unplaced.
     * @param props.onMove - receives the new corner during a drag.
     * @param props.onCommit - receives the final corner when the drag ends.
     * @param props.rectOf - returns the chip's live bounding rect, or undefined.
     * @returns the pointer handlers to spread onto the chip element.
     */
    function useChipDrag(props) {
      const { position, onMove, onCommit, rectOf } = props
      // The gesture in progress, or null. A ref rather than state so that moving
      // the pointer never causes a render on its own — the parent re-renders from
      // its own position state, which is the single source of truth.
      const gesture = React.useRef(null)

      /**
       * The chip's current top-left corner in client coordinates.
       *
       * Prefers the measured rectangle, because it is the only answer that is
       * correct BOTH while unplaced (pinned by right/bottom) and while placed. The
       * `position` prop is the fallback for a caller with no element to measure.
       */
      const cornerOf = () => {
        const rect = typeof rectOf === 'function' ? rectOf() : undefined
        if (rect !== undefined && rect !== null && Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
          return { x: rect.left, y: rect.top, size: { width: rect.width, height: rect.height } }
        }
        const fallback = position ?? { x: 0, y: 0 }
        return { x: fallback.x, y: fallback.y, size: undefined }
      }

      const onPointerDown = React.useCallback(
        (event) => {
          // Ignore secondary buttons so a right-click still opens a context menu.
          if (event.button !== undefined && event.button !== 0) return
          // Never start a drag from an interactive control inside the chip.
          const target = event.target
          const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
          if (tag === 'button' || tag === 'input' || tag === 'a' || tag === 'select') return
          const corner = cornerOf()
          gesture.current = {
            pointerId: event.pointerId,
            // Offset from the chip's REAL corner to the press point, so the chip
            // does not jump under the cursor when the drag starts.
            offsetX: event.clientX - corner.x,
            offsetY: event.clientY - corner.y,
            startX: event.clientX,
            startY: event.clientY,
            size: corner.size,
            moved: false,
          }
          // Capture keeps every later pointer event aimed at this element even when
          // the pointer leaves it, which is what makes a fast drag survive.
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch (error) {
            /* capture is best-effort; the drag still works while inside */
          }
        },
        // `cornerOf` closes over `position` and `rectOf`, so both are dependencies.
        [position, rectOf],
      )

      const onPointerMove = React.useCallback(
        (event) => {
          const active = gesture.current
          if (active === null || active.pointerId !== event.pointerId) return
          const dx = event.clientX - active.startX
          const dy = event.clientY - active.startY
          if (!active.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          active.moved = true
          event.preventDefault()
          onMove(
            clampPosition(
              { x: event.clientX - active.offsetX, y: event.clientY - active.offsetY },
              active.size,
            ),
          )
        },
        [onMove],
      )

      const finish = React.useCallback(
        (event) => {
          const active = gesture.current
          if (active === null || (event !== undefined && active.pointerId !== event.pointerId)) return
          gesture.current = null
          if (event !== undefined) {
            try {
              event.currentTarget.releasePointerCapture(active.pointerId)
            } catch (error) {
              /* already released */
            }
          }
          if (active.moved) onCommit(clampPosition({ x: event.clientX - active.offsetX, y: event.clientY - active.offsetY }, active.size))
        },
        [onCommit],
      )

      return {
        dragging: () => gesture.current !== null && gesture.current.moved,
        handlers: {
          onPointerDown,
          onPointerMove,
          onPointerUp: finish,
          onPointerCancel: finish,
        },
      }
    }

    /**
     * The player: the ONE audio element, mounted frame-wide.
     *
     * Registered into `shell.overlay`, so it outlives the Settings panel, the
     * Conversation and every sidebar tab. It renders the element unconditionally —
     * an `<audio>` with no `src` is inert — plus a small floating chip that appears
     * ONLY while something is playing, so the user can always see and stop the
     * music without opening Settings.
     *
     * The chip is DRAGGABLE: it starts bottom-right, and the user can put it
     * anywhere. The position is clamped to the viewport, survives a window resize
     * and is remembered across reloads.
     *
     * The layer itself is click-through; the chip opts back into pointer events.
     *
     * @param props.store - the shared playback store.
     * @param props.owner - the injected client context, for locale.
     */
    function BgmPlayer(props) {
      const store = props.store
      const state = usePlayback(store)
      const t = React.useMemo(() => translator(props.owner), [props.owner])

      const audioRef = React.useRef(null)
      const chipRef = React.useRef(null)

      // `null` means "not placed yet": the chip renders at its default bottom-right
      // corner and the position is only pinned once the user actually drags it.
      // Starting from a concrete pixel corner instead would need the viewport and
      // the chip's own size at first render, neither of which is known yet.
      //
      // Normalized through `?? null` because `readPosition()` answers `undefined`
      // when nothing is stored: leaving that `undefined` in state would defeat
      // every `position === null` guard below and feed `undefined` into the drag
      // hook, which reads `position.x` and throws.
      const [position, setPosition] = React.useState(() => readPosition() ?? null)

      // Hand the element to the store, and take it back on unmount. This is the
      // only place the element is created, which is what makes "exactly one audio
      // element" a property of the design rather than a hope.
      React.useEffect(() => {
        const element = audioRef.current
        if (element === null) return undefined
        return store.attach(element)
      }, [store])

      // The store starts empty; the row is what feeds it the settings document. On
      // a page where Settings has never been opened, fetch it straight away so the
      // music a user left playing resumes on reload without a visit to Settings.
      React.useEffect(() => {
        if (state.folder === '' && state.tracks.length === 0) void store.reload()
      }, [store, state.folder, state.tracks.length])

      /**
       * Keep the library listing fresh.
       *
       * The folder lives in the filesystem, which changes with no event this plugin
       * can subscribe to: deleting a track in Explorer changes no setting. Three
       * cheap triggers cover that without polling on every render:
       *
       *   - a periodic refresh, so a long session notices;
       *   - `visibilitychange`, because coming back to the tab is exactly when a
       *     user who just deleted files expects the change to be reflected;
       *   - a `focus` listener for the same reason on platforms that do not fire
       *     visibility changes for an already-visible window.
       *
       * A refresh is also triggered when playback ENDS on a track that no longer
       * exists — see the `ended` handler, which reloads before advancing rather than
       * blindly stepping to a slot that may now hold a different song.
       */
      React.useEffect(() => {
        const tick = () => store.refreshIfStale()
        const onVisible = () => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') tick()
        }
        const timer = setInterval(tick, LIBRARY_TTL_MS)
        const doc = typeof document === 'undefined' ? undefined : document
        doc?.addEventListener?.('visibilitychange', onVisible)
        globalThis.addEventListener?.('focus', onVisible)
        return () => {
          clearInterval(timer)
          doc?.removeEventListener?.('visibilitychange', onVisible)
          globalThis.removeEventListener?.('focus', onVisible)
        }
      }, [store])

      const commit = React.useCallback((next) => {
        setPosition(next)
        writePosition(next)
      }, [])

      /**
       * The chip's live bounding rectangle.
       *
       * The drag uses this rather than `position` because it is the only value that
       * is right in both states: while unplaced the chip is pinned by `right`/
       * `bottom` and `position` is null, so its real corner exists only in layout.
       *
       * `getBoundingClientRect` is optional-chained because this same code has to
       * run under a test harness whose stub elements have no layout at all.
       */
      const rectOf = React.useCallback(() => {
        const element = chipRef.current
        if (element === null || element === undefined) return undefined
        if (typeof element.getBoundingClientRect !== 'function') return undefined
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }, [])

      const drag = useChipDrag({
        // `null` is handed through as-is: the hook falls back to the measured
        // rectangle, and only uses this prop when there is no element to measure.
        position: position,
        onMove: setPosition,
        onCommit: commit,
        rectOf: rectOf,
      })

      // Keep a placed chip on screen when the window shrinks. Without this the chip
      // could sit outside the viewport with no way to bring it back, since it owns
      // the only control that could.
      React.useEffect(() => {
        if (position === null) return undefined
        const onResize = () => {
          const rect = rectOf()
          const next = clampPosition(position, rect)
          if (next.x !== position.x || next.y !== position.y) commit(next)
        }
        globalThis.addEventListener?.('resize', onResize)
        return () => globalThis.removeEventListener?.('resize', onResize)
      }, [position, commit, rectOf])

      const track = store.currentTrack()

      // While placed, all four offsets are pinned so the chip moves freely; while
      // unplaced it defaults to the bottom-right corner via `right`/`bottom`.
      const anchor =
        position === null
          ? { right: '16px', bottom: '16px' }
          : { left: String(position.x) + 'px', top: String(position.y) + 'px' }

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('audio', {
          ref: audioRef,
          preload: 'none',
          // Advancing on `ended` is what makes a folder play as a playlist.
          //
          // The reload runs FIRST, so the advance lands on the folder's current
          // contents rather than on a stale index. In a folder a user is editing,
          // the next slot may no longer exist, and stepping blindly would either
          // replay a deleted track or skip a live one.
          onEnded: () => {
            void store.reload()
            store.next()
          },
          onError: () => store.set({ playing: false }),
        }),
        state.playing && track !== undefined
          ? React.createElement(
              'div',
              Object.assign(
                {
                  ref: (element) => {
                    chipRef.current = element
                  },
                  title: t('dragHint'),
                  // The anchor merges into `style`, not into the props object:
                  // `right`/`bottom` are CSS offsets, and spreading them one level
                  // up would make them inert custom props while the chip silently
                  // stayed at the browser's default position.
                  style: Object.assign(
                    {
                      position: 'fixed',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 10px',
                      borderRadius: '999px',
                      background: 'var(--dsw-alias-bg-overlay)',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      color: 'var(--dsw-alias-label-primary)',
                      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
                      fontSize: '12px',
                      // The overlay layer is click-through; this chip opts back in.
                      pointerEvents: 'auto',
                      maxWidth: '320px',
                      // Above every shipped layer. DSH's own scale runs 1000–1100
                      // (`1000` is the mask/dialog layer, `1100` the menu layer),
                      // and a fullscreen document preview or a modal would otherwise
                      // paint straight over this card. The first version used `40`,
                      // a number invented here, which sat below all of them — that
                      // is why the card disappeared behind dialogs.
                      zIndex: 2147483647,
                      // The whole chip is the drag handle, so it advertises that.
                      cursor: 'grab',
                      // A drag must not select the track name as it passes over it.
                      userSelect: 'none',
                      touchAction: 'none',
                    },
                    anchor,
                  ),
                },
                drag.handlers,
              ),
              React.createElement(
                'span',
                {
                  style: {
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '150px',
                  },
                },
                track.name,
              ),
              React.createElement(Transport, { state, store, t, compact: true }),
            )
          : null,
      )
    }

    /**
     * Mount the browser half.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return

      ctx.inject(['slots', 'locale', 'configForms'], (owner) => {
        try {
          const slots = serviceAt(owner, 'slots')
          if (slots === undefined || typeof slots.inject !== 'function') return

          const store = playbackStore()

          const locale = serviceAt(owner, 'locale')
          if (locale !== undefined && typeof locale.register === 'function') {
            const dictionaries = () =>
              locale.register(LOCALE_NS, { zh: DICTIONARY_ZH, en: DICTIONARY_EN })
            if (typeof owner.effect === 'function') {
              owner.effect(dictionaries, 'dsh-bgm: dictionaries')
            } else {
              dictionaries()
            }
          }

          // The PLAYER goes in first, and unconditionally: it needs nothing from
          // the settings document, and it is the half that must exist even on a
          // deployment where the settings page is never opened.
          slots.inject(OVERLAY_SLOT, () =>
            slots.register(
              { name: OVERLAY_SLOT, id: OVERLAY_ID, order: 60 },
              () => React.createElement(BgmPlayer, { store: store, owner: owner }),
            ),
          )

          // The settings ROW is gated on the Host actually serving this plugin's
          // namespace: a profile whose schema package is missing should show no row
          // at all rather than an inert one. The player above is deliberately NOT
          // gated that way, since it does not depend on the settings document.
          //
          // The injected owner travels to the row through PROPS, not through a
          // React context. A context would need a provider above the row, and this
          // plugin does not own the tree it is rendered into — the settings page
          // mounts the registered component directly, with no wrapper of ours. An
          // unprovided context reads `undefined`, which silently degrades the row
          // to its no-services branch: the input renders, but empty and inert.
          const Row = () => React.createElement(BgmRow, { owner: owner, store: store })

          const forms = serviceAt(owner, 'configForms')
          if (forms !== undefined && typeof forms.whileServed === 'function') {
            const serve = () =>
              forms.whileServed([SETTINGS_NAMESPACE], () =>
                slots.inject(ROW_SLOT, () =>
                  slots.register({ name: ROW_SLOT, id: ROW_ID, order: ROW_ORDER }, Row),
                ),
              )
            if (typeof owner.effect === 'function') owner.effect(serve, 'dsh-bgm: general row')
            else serve()
            return
          }

          slots.inject(ROW_SLOT, () =>
            slots.register({ name: ROW_SLOT, id: ROW_ID, order: ROW_ORDER }, Row),
          )
        } catch (error) {
          // A racing registration must not become an exception in the slot
          // ledger's store notification: React's own subscription rides the same
          // notification, so a throw here would leave a visible but dead row.
          console.warn('dsh-bgm: settings row not registered', error)
        }
      })
    }

    return {
      // Kept empty on purpose: a declared-but-absent service parks the fiber, and
      // every service this half needs is optional at activation time. They are
      // reached through the dynamic `ctx.inject` above instead.
      inject: [],
      apply: apply,
    }
  },
})
