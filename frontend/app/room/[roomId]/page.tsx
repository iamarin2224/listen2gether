'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import { Socket } from 'socket.io-client';
import { getSocket } from '@/lib/socket';
import { RoomState, Track } from './types';

// ── Helpers ──

function formatTime(seconds?: number): string {
  if (seconds == null || isNaN(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

function MusicWaveIcon({ playing }: { playing: boolean }) {
  return (
    <div className="flex items-end gap-[3px] h-5">
      {[0.5, 0.9, 0.7, 1.0, 0.6].map((scale, i) => (
        <span
          key={i}
          className={`block w-1 rounded-full bg-sky-400 transition-all duration-300 ${
            playing ? 'animate-wave' : 'opacity-40'
          }`}
          style={{
            height: playing ? `${scale * 16}px` : '4px',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

type ConnStatus = 'connecting' | 'synced' | 'reconnecting' | 'disconnected';

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = ((params?.roomId as string) ?? '').toUpperCase();

  // Determine backend URL dynamically:
  // On Vercel production -> use configured production Render URL.
  // Everywhere else (ngrok tunnel, unified gateway, local network IP, localhost) -> use window.location.origin.
  const backendUrl = typeof window !== 'undefined'
    ? (window.location.hostname.includes('vercel.app') && process.env.NEXT_PUBLIC_BACKEND_URL && !process.env.NEXT_PUBLIC_BACKEND_URL.includes('localhost')
        ? process.env.NEXT_PUBLIC_BACKEND_URL.replace(/\/$/, '')
        : window.location.origin)
    : (process.env.NEXT_PUBLIC_BACKEND_URL ?? '').replace(/\/$/, '');

  // ── State ──
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [roomNotFound, setRoomNotFound] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [connStatus, setConnStatus] = useState<ConnStatus>('connecting');
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      setCanShare(true);
    }
  }, []);

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

  // Continuous timer to advance slider smoothly
  useEffect(() => {
    const timer = setInterval(() => {
      const audio = audioRef.current;
      const state = roomStateRef.current;
      if (isSeekingRef.current) return;

      if (audio && !audio.paused && audio.currentTime > 0) {
        setCurrentTime(audio.currentTime);
      } else if (state?.isPlaying && state.currentTrack) {
        if (!state.isPlaying || !state._started) {
          // Track is paused or still buffering before first sound: freeze slider at anchorTime (0:00)
          setCurrentTime(state.anchorTime);
        } else {
          // If local audio is still buffering at 0:00, hold slider at anchorTime
          if (audio && (audio.currentTime === 0 || audio.readyState < 3)) {
            setCurrentTime(state.anchorTime);
          } else {
            const elapsed = (Date.now() - state.anchorTimestamp) / 1000;
            setCurrentTime(state.anchorTime + elapsed);
          }
        }
      }
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // ── Compute target playback position ──
  const computeTargetTime = useCallback((state: RoomState): number => {
    if (!state.isPlaying) return state.anchorTime;
    // If the track hasn't actually started playing sound yet (stream extraction / initial buffering),
    // do NOT advance target time into the future!
    if (state.currentTrack && !state._started) return state.anchorTime;
    const elapsed = (Date.now() - state.anchorTimestamp) / 1000;
    return state.anchorTime + elapsed;
  }, []);

  // ── Load audio for a track ──
  const loadTrack = useCallback(
    (track: Track, autoplay: boolean, startAt = 0) => {
      const audio = audioRef.current;
      if (!audio) return;
      setIsBuffering(true);
      const src = `${backendUrl}/api/stream/${track.videoId}`;
      if (audio.src !== src) {
        audio.src = src;
      }

      // If starting fresh (< 3.0s), do NOT seek; start cleanly at 0:00 without skipping intro
      if (startAt >= 3.0) {
        const setInitialTime = () => {
          try {
            audio.currentTime = startAt;
          } catch {}
          audio.removeEventListener('loadedmetadata', setInitialTime);
        };
        if (audio.readyState >= 1) {
          try {
            audio.currentTime = startAt;
          } catch {}
        } else {
          audio.addEventListener('loadedmetadata', setInitialTime);
        }
      }

      if (autoplay) {
        const p = audio.play();
        if (p !== undefined) {
          p.then(() => {
            setAudioUnlocked(true);
            audioUnlockedRef.current = true;
          }).catch((err) => {
            console.warn('[Audio] Autoplay pending user tap:', err);
            if (!audioUnlockedRef.current) {
              setAudioUnlocked(false);
            }
          });
        }
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
      const needsSrcChange = audio.src !== targetSrc || Boolean(audio.error);

      if (needsSrcChange) {
        loadTrack(state.currentTrack, state.isPlaying, computeTargetTime(state));
        return;
      }

      const targetTime = computeTargetTime(state);

      // Correct drift > 1.2 s (only if audio is ready to seek, track has started, and not scrubbing)
      if (state._started && audio.readyState >= 2 && !isSeekingRef.current) {
        const drift = Math.abs(audio.currentTime - targetTime);
        if (drift > 1.2) {
          try {
            audio.currentTime = targetTime;
          } catch {}
        }
      }

      if (state.isPlaying) {
        if (audio.paused) {
          const p = audio.play();
          if (p !== undefined) {
            p.then(() => {
              setAudioUnlocked(true);
              audioUnlockedRef.current = true;
            }).catch((err) => {
              console.warn('[Audio] syncAudio play pending user interaction:', err);
              if (!audioUnlockedRef.current) {
                setAudioUnlocked(false);
              }
            });
          }
        }
      } else {
        if (!audio.paused) {
          audio.pause();
        }
        if (!isSeekingRef.current && audio.readyState >= 2) {
          try {
            audio.currentTime = state.anchorTime;
          } catch {}
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
      album: 'Listen2Gether (L2G)',
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
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      socketRef.current?.emit('previous_track', { roomId });
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      socketRef.current?.emit('skip_track', { roomId });
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        socketRef.current?.emit('seek', {
          roomId,
          time: details.seekTime,
          anchorTime: details.seekTime,
        });
      }
    });
  }, [roomId]);

  // ── Setup audioSession for iOS background audio ──
  const setupAudioSession = useCallback(() => {
    if (typeof navigator !== 'undefined' && (navigator as any).audioSession) {
      try {
        (navigator as any).audioSession.type = 'playback';
      } catch {}
    }
  }, []);

  // ── On mount: connect socket ──
  useEffect(() => {
    setupAudioSession();
    wireMediaSessionHandlers();

    const socket = getSocket(backendUrl);
    socketRef.current = socket;

    const isCreated = typeof window !== 'undefined' && sessionStorage.getItem(`l2g_created_${roomId}`) === 'true';

    socket.on('connect', () => {
      setConnStatus('synced');
      setRoomNotFound(false);
      socket.emit('join_room', { roomId, displayName: 'Listener', create: isCreated });
    });

    socket.on('disconnect', () => {
      setConnStatus('reconnecting');
    });

    socket.on('connect_error', () => {
      setConnStatus('reconnecting');
    });

    socket.on('room_not_found', () => {
      setRoomNotFound(true);
      setConnStatus('disconnected');
    });

    socket.on('room_state', (state: RoomState) => {
      setRoomNotFound(false);
      setRoomState(state);
    });

    if (!socket.connected) {
      socket.connect();
    } else {
      setConnStatus('synced');
      socket.emit('join_room', { roomId, displayName: 'Listener', create: isCreated });
    }

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('room_not_found');
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
      if (!isSeekingRef.current && audio) {
        setCurrentTime(audio.currentTime);
      }
    }

    function onDurationChange() {
      if (audio) setDuration(audio.duration);
    }

    function onWaiting() {
      setIsBuffering(true);
    }

    function onPlaying() {
      setIsBuffering(false);
      setAudioUnlocked(true);
      audioUnlockedRef.current = true;

      const state = roomStateRef.current;
      if (state && state.currentTrack && audio) {
        // If track is not yet marked started on server, or near 0, notify server immediately!
        if (!state._started || audio.currentTime < 5.0) {
          socketRef.current?.emit('track_started', {
            roomId,
            videoId: state.currentTrack.videoId,
            currentTime: audio.currentTime,
          });
        }
      }
    }

    function onEnded() {
      const state = roomStateRef.current;
      if (!state || !state.currentTrack || !audio) return;

      // Ignore premature false ended events
      if (audio.currentTime < 5.0) {
        console.warn('[Audio] Premature onEnded ignored at', audio.currentTime);
        return;
      }

      const currentVid = state.currentTrack?.videoId;
      socketRef.current?.emit('track_ended', {
        roomId,
        videoId: currentVid,
      });

      // Chain continuous playback immediately inside the onEnded callback (iOS-safe)
      if (state.queue && state.queue.length > 0) {
        const next = state.queue[0];
        const nextSrc = `${backendUrl}/api/stream/${next.videoId}`;
        audio.src = nextSrc;
        const p = audio.play();
        if (p !== undefined) {
          p.catch(() => {});
        }
      }
    }

    function onCanPlay() {
      setIsBuffering(false);
      const state = roomStateRef.current;
      if (!state || !state.isPlaying || !state.currentTrack || !audio) return;

      // Only seek forward if the track has already started playing in the room!
      if (state._started) {
        const target = computeTargetTime(state);
        if (Math.abs(audio.currentTime - target) > 1.2) {
          try {
            audio.currentTime = target;
          } catch {}
        }
      }
      if (audio.paused) {
        const p = audio.play();
        if (p !== undefined) {
          p.then(() => {
            setAudioUnlocked(true);
            audioUnlockedRef.current = true;
          }).catch((err) => {
            console.warn('[Audio] Autoplay on canplay blocked:', err);
            if (!audioUnlockedRef.current) {
              setAudioUnlocked(false);
            }
          });
        }
      }
    }

    function onError() {
      setIsBuffering(false);
      const err = audio!.error;
      console.error('[Audio] Native playback error on audio element:', err?.code, err?.message, 'src:', audio!.src);
      // Automatically recover after transient network, proxy, or 403 error
      if (roomStateRef.current?.isPlaying && roomStateRef.current?.currentTrack) {
        const track = roomStateRef.current.currentTrack;
        setTimeout(() => {
          if (audioRef.current && roomStateRef.current?.isPlaying && roomStateRef.current?.currentTrack?.videoId === track.videoId) {
            console.log('[Audio] Auto-recovering from playback error for:', track.videoId);
            const freshSrc = `${backendUrl}/api/stream/${track.videoId}?retry=${Date.now()}`;
            audioRef.current.src = freshSrc;
            audioRef.current.load();
            const target = computeTargetTime(roomStateRef.current);
            if (target > 0) {
              try { audioRef.current.currentTime = target; } catch {}
            }
            audioRef.current.play().catch((e) => console.warn('[Audio] Auto-recovery play error:', e));
          }
        }, 1000);
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('canplay', onCanPlay);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('canplay', onCanPlay);
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

  function handleClearSearch() {
    setSearchQuery('');
    setSearchResults([]);
  }

  function handlePlayNow(track: Track) {
    setupAudioSession();
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;
    setCurrentTime(0);

    // Immediately load and play the track on this device within the user gesture!
    loadTrack(track, true, 0);

    // Optimistically update roomState to playing
    setRoomState((prev) =>
      prev
        ? {
            ...prev,
            currentTrack: track,
            isPlaying: true,
            anchorTime: 0,
            anchorTimestamp: Date.now(),
            _started: false,
            queue: prev.queue.filter((q) => q.videoId !== track.videoId),
          }
        : null
    );

    socketRef.current?.emit('play_now', { roomId, track });
    setSearchResults([]);
    setSearchQuery('');
  }

  function handlePlayFromQueue(track: Track, index: number) {
    setupAudioSession();
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;
    setCurrentTime(0);

    // Immediately load and play the track on this device within the user gesture!
    loadTrack(track, true, 0);

    // Optimistically update roomState to playing
    setRoomState((prev) =>
      prev
        ? {
            ...prev,
            currentTrack: track,
            isPlaying: true,
            anchorTime: 0,
            anchorTimestamp: Date.now(),
            _started: false,
            queue: prev.queue.filter((_, i) => i !== index),
          }
        : null
    );

    socketRef.current?.emit('play_now', { roomId, track, queueIndex: index });
  }

  function handleAddToQueue(track: Track) {
    setupAudioSession();
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;

    socketRef.current?.emit('add_to_queue', { roomId, track });
  }

  function handleUnlockLocalAudio() {
    if (!roomState || !roomState.currentTrack) return;
    setupAudioSession();
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;
    const audio = audioRef.current;
    if (!audio) return;

    const targetSrc = `${backendUrl}/api/stream/${roomState.currentTrack.videoId}`;
    const target = computeTargetTime(roomState);

    if (audio.error || !audio.src || !audio.src.includes(roomState.currentTrack.videoId)) {
      audio.src = targetSrc;
      audio.load();
    }
    if (Math.abs(audio.currentTime - target) > 1.0) {
      try {
        audio.currentTime = target;
      } catch {}
    }
    audio.play().catch((err) => {
      console.warn('[Audio] Unlock local play error:', err);
      if (err?.name === 'NotSupportedError') {
        audio.src = `${targetSrc}?r=${Date.now()}`;
        audio.load();
        audio.play().catch(() => {});
      }
    });
  }

  function handlePlayPause() {
    if (!roomState) return;

    setupAudioSession();
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;

    const audio = audioRef.current;

    if (roomState.isPlaying) {
      // Pause room
      if (audio) {
        audio.pause();
      }
      socketRef.current?.emit('play_pause', {
        roomId,
        action: 'pause',
      });
    } else {
      // Play room
      if (audio && roomState.currentTrack) {
        const targetSrc = `${backendUrl}/api/stream/${roomState.currentTrack.videoId}`;
        if (!audio.src || !audio.src.includes(roomState.currentTrack.videoId)) {
          audio.src = targetSrc;
          audio.load();
        }
        const p = audio.play();
        if (p !== undefined) p.catch(() => {});
      }
      socketRef.current?.emit('play_pause', {
        roomId,
        action: 'play',
      });
    }
  }

  function handlePrevious() {
    socketRef.current?.emit('previous_track', { roomId });
  }

  function handleSkip() {
    socketRef.current?.emit('skip_track', { roomId });
  }

  function handleRemoveFromQueue(index: number) {
    // Optimistic removal
    setRoomState((prev) =>
      prev ? { ...prev, queue: prev.queue.filter((_, i) => i !== index) } : null
    );
    socketRef.current?.emit('remove_from_queue', { roomId, index });
  }

  function handleMoveQueueItem(fromIndex: number, toIndex: number) {
    socketRef.current?.emit('move_queue_item', { roomId, fromIndex, toIndex });
  }

  function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value);
    setIsSeeking(true);
    setCurrentTime(val);
    if (audioRef.current) {
      try {
        audioRef.current.currentTime = val;
      } catch {}
    }
  }

  function handleSeekCommit(
    e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>
  ) {
    const val = parseFloat((e.currentTarget as HTMLInputElement).value);
    setIsSeeking(false);
    setCurrentTime(val);
    if (audioRef.current) {
      try {
        audioRef.current.currentTime = val;
      } catch {}
    }
    socketRef.current?.emit('seek', { roomId, time: val, anchorTime: val });
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  async function handleShare() {
    if (navigator.share) {
      await navigator.share({
        title: 'Listen2Gether (L2G) Room',
        text: `Join my Listen2Gether room: ${roomId}`,
        url: window.location.href,
      }).catch(() => {});
    }
  }

  function handleCreateSpecificRoom(code: string) {
    sessionStorage.setItem(`l2g_created_${code}`, 'true');
    setRoomNotFound(false);
    socketRef.current?.emit('join_room', { roomId: code, displayName: 'Listener', create: true });
  }

  // ── Derived values ──
  const track = roomState?.currentTrack ?? null;
  const queue = roomState?.queue ?? [];
  const isPlaying = roomState?.isPlaying ?? false;
  const seekMax = duration > 0 ? duration : track?.duration ?? 100;

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col relative">
      {/* Hidden native audio element - SINGLE PERSISTENT INSTANCE FOR LIFETIME OF ROOM */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        playsInline
        preload="auto"
        className="hidden"
      />

      {roomNotFound ? (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center px-4">
          <div className="bg-gray-800 border border-gray-700 rounded-3xl p-8 max-w-md w-full text-center space-y-6 shadow-2xl">
            <div className="w-16 h-16 bg-red-500/10 text-red-400 rounded-full flex items-center justify-center mx-auto text-3xl">
              🔍
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-white">Room Not Found</h1>
              <p className="text-gray-400 text-sm">
                Room <span className="font-mono font-bold text-sky-400 px-2 py-0.5 bg-gray-900 rounded">{roomId}</span> does not exist or has expired due to inactivity.
              </p>
            </div>
            <div className="space-y-3 pt-2">
              <button
                onClick={() => handleCreateSpecificRoom(roomId)}
                className="w-full bg-sky-500 hover:bg-sky-400 active:bg-sky-600 text-white font-semibold py-3 rounded-xl transition text-sm shadow-lg shadow-sky-900/40 cursor-pointer"
              >
                Create Room &ldquo;{roomId}&rdquo;
              </button>
              <button
                onClick={() => router.push('/')}
                className="w-full bg-gray-700 hover:bg-gray-600 active:bg-gray-800 text-white font-semibold py-3 rounded-xl transition text-sm cursor-pointer"
              >
                Return to Home
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ── Top Bar ── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/90 backdrop-blur sticky top-0 z-30">
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 cursor-pointer"
        >
          <span className="text-sky-400 font-extrabold text-lg tracking-tight">
            Listen<span className="text-white">2Gether</span>
          </span>
          <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded border border-sky-500/20">
            L2G
          </span>
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

        {/* Room code */}
        <span className="text-xs text-gray-400 font-mono bg-gray-800 px-2.5 py-1 rounded-lg border border-gray-700 font-bold">
          {roomId}
        </span>
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
                    <MusicWaveIcon playing={isPlaying && !isBuffering} />
                    <span className="text-xs text-gray-500">
                      {isBuffering && isPlaying ? 'Buffering…' : isPlaying ? 'Playing' : 'Paused'}
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
                  value={currentTime}
                  onChange={handleSeekChange}
                  onMouseUp={handleSeekCommit}
                  onTouchEnd={handleSeekCommit}
                  className="w-full h-1 accent-sky-400 cursor-pointer"
                />
                <div className="flex justify-between text-xs text-gray-500">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(seekMax)}</span>
                </div>
              </div>

              {/* Gentle inline prompt if browser blocked autoplay */}
              {isPlaying && !audioUnlocked && (
                <div className="flex items-center justify-between bg-sky-500/10 border border-sky-500/20 px-3 py-2 rounded-xl text-xs text-sky-300">
                  <span>🎧 Audio is ready — tap to hear</span>
                  <button
                    onClick={handleUnlockLocalAudio}
                    className="bg-sky-500 hover:bg-sky-400 text-white font-semibold px-3 py-1 rounded-lg text-xs transition cursor-pointer"
                  >
                    Listen Now
                  </button>
                </div>
              )}

              {/* Controls */}
              <div className="flex items-center justify-center gap-5">
                {/* Previous */}
                <button
                  onClick={handlePrevious}
                  className="w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 active:bg-gray-800 flex items-center justify-center transition-colors cursor-pointer"
                  aria-label="Previous Track"
                  title="Previous Track / Restart"
                >
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                  </svg>
                </button>

                {/* Play / Pause */}
                <button
                  onClick={handlePlayPause}
                  className="w-14 h-14 rounded-full bg-sky-500 hover:bg-sky-400 active:bg-sky-600 flex items-center justify-center shadow-lg shadow-sky-900/50 transition-colors cursor-pointer"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isBuffering && isPlaying ? (
                    <svg className="w-6 h-6 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                  ) : isPlaying ? (
                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Skip / Next */}
                <button
                  onClick={handleSkip}
                  className="w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 active:bg-gray-800 flex items-center justify-center transition-colors cursor-pointer"
                  aria-label="Next Track"
                  title="Next Track"
                >
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
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
            className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer"
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
          {canShare && (
            <button
              onClick={handleShare}
              className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer"
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
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              Search Music
            </h2>
            {(searchQuery || searchResults.length > 0) && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="text-xs text-sky-400 hover:text-sky-300 font-medium transition cursor-pointer"
              >
                Clear Search ✕
              </button>
            )}
          </div>
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search YouTube songs, artists…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 pr-8 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500 transition"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white text-xs p-1"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={isSearching}
              className="bg-sky-500 hover:bg-sky-400 active:bg-sky-600 disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center cursor-pointer"
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
            <div className="space-y-2">
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
                      <p className="text-xs text-gray-400 truncate">{result.artist}</p>
                      <p className="text-xs text-gray-500">{formatTime(result.duration)}</p>
                    </div>
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => handlePlayNow(result)}
                        className="text-xs bg-sky-500 hover:bg-sky-400 active:bg-sky-600 px-3 py-1 rounded-lg font-semibold transition-colors whitespace-nowrap cursor-pointer text-white"
                      >
                        ▶ Play
                      </button>
                      <button
                        onClick={() => handleAddToQueue(result)}
                        className="text-xs bg-gray-700 hover:bg-gray-600 active:bg-gray-800 px-3 py-1 rounded-lg font-semibold transition-colors whitespace-nowrap cursor-pointer text-gray-200"
                      >
                        + Queue
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* ── Queue ── */}
        {queue.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              Up Next ({queue.length})
            </h2>
            <ul className="space-y-2 max-h-72 overflow-y-auto scrollbar-thin pr-1">
              {queue.map((item, idx) => (
                <li
                  key={`${item.videoId}-${idx}`}
                  className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-xl p-3"
                >
                  <span className="text-gray-500 text-xs w-4 text-center flex-shrink-0 font-mono">
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
                    <p className="text-xs text-gray-400 truncate">{item.artist}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Reorder Up / Down buttons */}
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => handleMoveQueueItem(idx, idx - 1)}
                        disabled={idx === 0}
                        className="text-[10px] w-5 h-4 flex items-center justify-center bg-gray-700 hover:bg-gray-600 disabled:opacity-20 rounded text-gray-300 transition cursor-pointer"
                        title="Move Up"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => handleMoveQueueItem(idx, idx + 1)}
                        disabled={idx === queue.length - 1}
                        className="text-[10px] w-5 h-4 flex items-center justify-center bg-gray-700 hover:bg-gray-600 disabled:opacity-20 rounded text-gray-300 transition cursor-pointer"
                        title="Move Down"
                      >
                        ▼
                      </button>
                    </div>

                    {/* Play From Queue Now (removes from queue & plays) */}
                    <button
                      onClick={() => handlePlayFromQueue(item, idx)}
                      className="text-xs bg-sky-500 hover:bg-sky-400 active:bg-sky-600 px-2 py-1.5 rounded-lg font-semibold transition text-white cursor-pointer"
                      title="Play Now"
                    >
                      ▶
                    </button>

                    {/* Remove from Queue */}
                    <button
                      onClick={() => handleRemoveFromQueue(idx)}
                      className="text-xs bg-gray-700 hover:bg-red-500/20 hover:text-red-400 text-gray-400 px-2 py-1.5 rounded-lg font-semibold transition cursor-pointer"
                      title="Remove from Queue"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Room Info Footer ── */}
        <div className="flex items-center justify-between text-xs text-gray-500 border-t border-gray-800 pt-4">
          <span>
            Room: <span className="font-mono text-gray-300 font-bold">{roomId}</span>
          </span>
          <span className="text-gray-600">Listen2Gether (L2G) — Synchronized Audio</span>
        </div>
      </main>
        </>
      )}
    </div>
  );
}
