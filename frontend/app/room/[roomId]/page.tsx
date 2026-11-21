'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import { getSocket } from '@/lib/socket';
import type { Track, RoomState } from './types';
import type { Socket } from 'socket.io-client';

// ─── Types ───────────────────────────────────────────────────────────────────

type ConnStatus = 'connecting' | 'synced' | 'reconnecting';

// Augment Navigator for non-standard iOS APIs
declare global {
  interface Navigator {
    audioSession?: { type: string };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function MusicWaveIcon({ playing }: { playing: boolean }) {
  return (
    <div className="flex items-end gap-[2px] h-5">
      {[0.6, 1, 0.75, 1.1, 0.65].map((scale, i) => (
        <span
          key={i}
          className={`block w-1 rounded-full ${playing ? 'bg-sky-400 animate-wave' : 'bg-gray-500'}`}
          style={{
            height: `${scale * 18}px`,
            animationDelay: playing ? `${i * 0.14}s` : '0s',
          }}
        />
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = (params?.roomId as string) ?? '';

  const backendUrl = (
    process.env.NEXT_PUBLIC_BACKEND_URL ?? ''
  ).replace(/\/$/, '');

  // ── State ──
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [connStatus, setConnStatus] = useState<ConnStatus>('connecting');
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [displayName, setDisplayName] = useState('Listener');

  // ── Refs ──
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const roomStateRef = useRef<RoomState | null>(null);
  const isSeekingRef = useRef(false);
  const audioUnlockedRef = useRef(false);

  // Keep refs in sync with state
  useEffect(() => { roomStateRef.current = roomState; }, [roomState]);
  useEffect(() => { isSeekingRef.current = isSeeking; }, [isSeeking]);
  useEffect(() => { audioUnlockedRef.current = audioUnlocked; }, [audioUnlocked]);

  // ── Compute target playback position ──
  const computeTargetTime = useCallback((state: RoomState): number => {
    if (!state.isPlaying) return state.anchorTime;
    const elapsed = (Date.now() - state.anchorTimestamp) / 1000;
    return state.anchorTime + elapsed;
  }, []);

  // ── Load audio for a track ──
  const loadTrack = useCallback(
    (track: Track, autoplay: boolean, startAt = 0) => {
      const audio = audioRef.current;
      if (!audio) return;
      const src = `${backendUrl}/api/stream/${track.videoId}`;
      if (audio.src !== src) {
        audio.src = src;
        audio.load();
      }
      if (startAt > 0.5) {
        audio.currentTime = startAt;
      }
      if (autoplay) {
        audio.play().catch(() => {
          // Autoplay blocked — user must tap "Join Audio Session"
        });
      }
    },
    [backendUrl]
  );

  // ── Sync audio to room state ──
  const syncAudio = useCallback(
    (state: RoomState) => {
      const audio = audioRef.current;
      if (!audio) return;

      if (!state.currentTrack) {
        audio.pause();
        return;
      }

      const targetSrc = `${backendUrl}/api/stream/${state.currentTrack.videoId}`;
      const needsSrcChange = audio.src !== targetSrc;

      if (needsSrcChange) {
        loadTrack(state.currentTrack, state.isPlaying, computeTargetTime(state));
        return;
      }

      const targetTime = computeTargetTime(state);

      // Correct drift > 1.5 s (but not while user is dragging)
      if (!isSeekingRef.current) {
        const drift = Math.abs(audio.currentTime - targetTime);
        if (drift > 1.5) {
          audio.currentTime = targetTime;
        }
      }

      if (state.isPlaying) {
        if (audio.paused) {
          audio.play().catch(() => {});
        }
      } else {
        if (!audio.paused) {
          audio.pause();
        }
        if (!isSeekingRef.current) {
          audio.currentTime = state.anchorTime;
        }
      }
    },
    [backendUrl, computeTargetTime, loadTrack]
  );

  // ── mediaSession helpers ──
  const updateMediaSession = useCallback((track: Track) => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: 'SyncWave',
      artwork: [
        { src: track.thumbnail, sizes: '480x360', type: 'image/jpeg' },
      ],
    });
  }, []);

  const wireMediaSessionHandlers = useCallback(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
      socketRef.current?.emit('play_pause', { roomId, action: 'play' });
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      socketRef.current?.emit('play_pause', { roomId, action: 'pause' });
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      socketRef.current?.emit('skip_track', { roomId });
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        socketRef.current?.emit('seek', { roomId, time: details.seekTime });
      }
    });
  }, [roomId]);

  // ── Setup audioSession for iOS background audio ──
  const setupAudioSession = useCallback(() => {
    if (navigator.audioSession) {
      navigator.audioSession.type = 'playback';
    }
  }, []);

  // ── On mount: resolve display name, connect socket ──
  useEffect(() => {
    const storedName =
      sessionStorage.getItem('syncwave_displayName') ?? 'Listener';
    setDisplayName(storedName);

    // Setup audioSession immediately
    setupAudioSession();

    // Wire mediaSession handlers (they can be set even before metadata)
    wireMediaSessionHandlers();

    const socket = getSocket(backendUrl);
    socketRef.current = socket;

    // ── Socket event handlers ──
    socket.on('connect', () => {
      setConnStatus('synced');
      socket.emit('join_room', { roomId, displayName: storedName });
    });

    socket.on('disconnect', () => {
      setConnStatus('reconnecting');
    });

    socket.on('connect_error', () => {
      setConnStatus('reconnecting');
    });

    socket.on('room_state', (state: RoomState) => {
      setRoomState(state);
    });

    if (!socket.connected) {
      socket.connect();
    } else {
      setConnStatus('synced');
      socket.emit('join_room', { roomId, displayName: storedName });
    }

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('room_state');
      socket.emit('leave_room', { roomId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, backendUrl]);

  // ── Sync audio whenever roomState changes ──
  useEffect(() => {
    if (!roomState) return;
    syncAudio(roomState);
    if (roomState.currentTrack) {
      updateMediaSession(roomState.currentTrack);
    }
  }, [roomState, syncAudio, updateMediaSession]);

  // ── audio element event wiring ──
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function onTimeUpdate() {
      if (!isSeekingRef.current) {
        setCurrentTime(audio!.currentTime);
      }
    }

    function onDurationChange() {
      setDuration(audio!.duration);
    }

    function onEnded() {
      const state = roomStateRef.current;
      if (!state) return;

      socketRef.current?.emit('track_ended', { roomId });

      // Optimistically load next if queue is known
      if (state.queue.length > 0) {
        const next = state.queue[0];
        const src = `${backendUrl}/api/stream/${next.videoId}`;
        audio!.src = src;
        audio!.load();
        audio!.play().catch(() => {});
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
    };
  }, [roomId, backendUrl]);

  // ── Handlers ──

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch(
        `${backendUrl}/api/search?q=${encodeURIComponent(searchQuery.trim())}`
      );
      if (!res.ok) throw new Error('Search failed');
      const data: Track[] = await res.json();
      setSearchResults(data);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  function handlePlayNow(track: Track) {
    socketRef.current?.emit('play_now', { roomId, track });
    setSearchResults([]);
    setSearchQuery('');
  }

  function handleAddToQueue(track: Track) {
    socketRef.current?.emit('add_to_queue', { roomId, track });
  }

  function handlePlayPause() {
    if (!roomState) return;
    socketRef.current?.emit('play_pause', {
      roomId,
      action: roomState.isPlaying ? 'pause' : 'play',
    });
  }

  function handleSkip() {
    socketRef.current?.emit('skip_track', { roomId });
  }

  function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value);
    setIsSeeking(true);
    setCurrentTime(val);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
    }
  }

  function handleSeekCommit(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value);
    setIsSeeking(false);
    socketRef.current?.emit('seek', { roomId, time: val });
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: ignore
    }
  }

  async function handleShare() {
    if (navigator.share) {
      await navigator.share({
        title: 'SyncWave Room',
        text: `Join my SyncWave room: ${roomId}`,
        url: window.location.href,
      }).catch(() => {});
    }
  }

  // ── iOS audio unlock overlay handler ──
  async function handleUnlockAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    setupAudioSession();
    try {
      await audio.play();
    } catch {
      // If still blocked, that's OK — we still mark unlocked so overlay hides
    }
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;
  }

  // ── Derived values ──
  const track = roomState?.currentTrack ?? null;
  const listenerCount = roomState?.listeners?.length ?? 0;
  const queue = roomState?.queue ?? [];
  const isPlaying = roomState?.isPlaying ?? false;
  const seekMax = duration > 0 ? duration : track?.duration ?? 100;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">

      {/* Hidden native audio — NEVER an iframe */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        playsInline
        crossOrigin="anonymous"
        preload="metadata"
        className="hidden"
      />

      {/* ── iOS Audio Unlock Overlay ── */}
      {isPlaying && !audioUnlocked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <button
            onClick={handleUnlockAudio}
            className="flex flex-col items-center gap-4 bg-gray-800 border border-gray-700 rounded-3xl px-10 py-10 shadow-2xl active:scale-95 transition-transform"
          >
            <span className="text-5xl">🎵</span>
            <span className="text-xl font-bold text-white">Tap to Join Audio Session</span>
            <span className="text-sm text-gray-400 text-center max-w-xs">
              Tap to start listening in sync with everyone.
            </span>
            <span className="mt-2 bg-sky-500 text-white px-8 py-3 rounded-full font-semibold text-sm">
              Join
            </span>
          </button>
        </div>
      )}

      {/* ── Top Bar ── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/90 backdrop-blur sticky top-0 z-30">
        <button
          onClick={() => router.push('/')}
          className="text-sky-400 font-extrabold text-lg tracking-tight"
        >
          Sync<span className="text-white">Wave</span>
        </button>

        {/* Connection pill */}
        <span
          className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
            connStatus === 'synced'
              ? 'bg-emerald-900/60 text-emerald-400'
              : connStatus === 'reconnecting'
              ? 'bg-yellow-900/60 text-yellow-400'
              : 'bg-gray-800 text-gray-400'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              connStatus === 'synced'
                ? 'bg-emerald-400'
                : connStatus === 'reconnecting'
                ? 'bg-yellow-400 animate-pulse'
                : 'bg-gray-400 animate-pulse'
            }`}
          />
          {connStatus === 'synced'
            ? 'Synced'
            : connStatus === 'reconnecting'
            ? 'Reconnecting…'
            : 'Connecting…'}
        </span>

        {/* Room code + listener count */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-mono bg-gray-800 px-2 py-1 rounded-lg">
            {roomId}
          </span>
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 11a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 1114 0H3z" />
            </svg>
            {listenerCount}
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-xl mx-auto w-full px-4 pb-8 gap-6 pt-6">

        {/* ── Now Playing ── */}
        <section className="bg-gray-800 rounded-2xl p-5 border border-gray-700 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Now Playing
          </h2>

          {track ? (
            <>
              <div className="flex gap-4 items-center">
                <div className="relative w-16 h-16 flex-shrink-0 rounded-xl overflow-hidden bg-gray-700">
                  <Image
                    src={track.thumbnail}
                    alt={track.title}
                    fill
                    sizes="64px"
                    className="object-cover"
                    unoptimized
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white text-sm leading-snug line-clamp-2">
                    {track.title}
                  </p>
                  <p className="text-xs text-gray-400 mt-1 truncate">{track.artist}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <MusicWaveIcon playing={isPlaying} />
                    <span className="text-xs text-gray-500">
                      {isPlaying ? 'Playing' : 'Paused'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Seek bar */}
              <div className="space-y-1">
                <input
                  type="range"
                  min={0}
                  max={seekMax}
                  step={0.5}
                  value={isSeeking ? currentTime : currentTime}
                  onChange={handleSeekChange}
                  onMouseUp={handleSeekCommit}
                  onTouchEnd={handleSeekCommit as unknown as React.TouchEventHandler<HTMLInputElement>}
                  className="w-full h-1 accent-sky-400"
                />
                <div className="flex justify-between text-xs text-gray-500">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(seekMax)}</span>
                </div>
              </div>

              {/* Controls */}
              <div className="flex items-center justify-center gap-6">
                {/* Play / Pause */}
                <button
                  onClick={handlePlayPause}
                  className="w-14 h-14 rounded-full bg-sky-500 hover:bg-sky-400 active:bg-sky-600 flex items-center justify-center shadow-lg shadow-sky-900/50 transition-colors"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    /* Pause icon */
                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    /* Play icon */
                    <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Skip */}
                <button
                  onClick={handleSkip}
                  className="w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center transition-colors"
                  aria-label="Skip"
                >
                  <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                  </svg>
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center py-8 gap-2 text-gray-500">
              <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
              <p className="text-sm">Nothing playing — search a track below!</p>
            </div>
          )}
        </section>

        {/* ── Share ── */}
        <section className="flex gap-2">
          <button
            onClick={handleCopyLink}
            className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            {copied ? (
              <><span>✓</span> Copied!</>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy Link
              </>
            )}
          </button>
          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <button
              onClick={handleShare}
              className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Share
            </button>
          )}
        </section>

        {/* ── Search ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Search Music
          </h2>
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="text"
              placeholder="Search YouTube…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500 transition"
            />
            <button
              type="submit"
              disabled={isSearching}
              className="bg-sky-500 hover:bg-sky-400 disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
            >
              {isSearching ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              )}
            </button>
          </form>

          {/* Search results */}
          {searchResults.length > 0 && (
            <ul className="space-y-2 max-h-80 overflow-y-auto scrollbar-thin pr-1">
              {searchResults.map((result) => (
                <li
                  key={result.videoId}
                  className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-xl p-3"
                >
                  <div className="relative w-14 h-10 flex-shrink-0 rounded-lg overflow-hidden bg-gray-700">
                    <Image
                      src={result.thumbnail}
                      alt={result.title}
                      fill
                      sizes="56px"
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white line-clamp-1">{result.title}</p>
                    <p className="text-xs text-gray-500 truncate">{result.artist}</p>
                    <p className="text-xs text-gray-600">{formatTime(result.duration)}</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <button
                      onClick={() => handlePlayNow(result)}
                      className="text-xs bg-sky-500 hover:bg-sky-400 px-2.5 py-1 rounded-lg font-semibold transition-colors whitespace-nowrap"
                    >
                      ▶ Play
                    </button>
                    <button
                      onClick={() => handleAddToQueue(result)}
                      className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-1 rounded-lg font-semibold transition-colors whitespace-nowrap"
                    >
                      + Queue
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Queue ── */}
        {queue.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              Up Next ({queue.length})
            </h2>
            <ul className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin pr-1">
              {queue.map((item, idx) => (
                <li
                  key={`${item.videoId}-${idx}`}
                  className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-xl p-3"
                >
                  <span className="text-gray-600 text-xs w-4 text-center flex-shrink-0">
                    {idx + 1}
                  </span>
                  <div className="relative w-12 h-9 flex-shrink-0 rounded-lg overflow-hidden bg-gray-700">
                    <Image
                      src={item.thumbnail}
                      alt={item.title}
                      fill
                      sizes="48px"
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white line-clamp-1">{item.title}</p>
                    <p className="text-xs text-gray-500 truncate">{item.artist}</p>
                  </div>
                  {idx === 0 && (
                    <button
                      onClick={handleSkip}
                      className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-1 rounded-lg font-semibold transition-colors"
                    >
                      Skip
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Room Info Footer ── */}
        <div className="flex items-center justify-between text-xs text-gray-600 border-t border-gray-800 pt-4">
          <span>
            Room: <span className="font-mono text-gray-400">{roomId}</span>
          </span>
          <span>
            {listenerCount} listener{listenerCount !== 1 ? 's' : ''}
          </span>
          <span className="text-gray-700">SyncWave</span>
        </div>
      </main>
    </div>
  );
}
