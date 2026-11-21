'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function MusicWaveIcon() {
  return (
    <div className="flex items-end gap-[3px] h-8">
      {[0.6, 1, 0.8, 1.2, 0.7, 1, 0.9].map((scale, i) => (
        <span
          key={i}
          className="block w-1.5 bg-sky-400 rounded-full animate-wave"
          style={{
            height: `${scale * 24}px`,
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </div>
  );
}

function generateRoomCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function parseRoomCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? trimmed;
  } catch {
    return trimmed.split('/').filter(Boolean).pop() ?? trimmed;
  }
}

export default function HomePage() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const parsedCode = parseRoomCode(joinCode);
  const isValidPattern = /^[A-Za-z0-9]{6}$/.test(parsedCode);

  async function handleCreateRoom() {
    setIsCreating(true);
    const slug = generateRoomCode();
    sessionStorage.setItem(`l2g_created_${slug}`, 'true');
    try {
      await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: slug }),
      });
    } catch {}
    router.push(`/room/${slug}`);
  }

  function handleJoinRoom() {
    const code = parseRoomCode(joinCode);
    if (!code) {
      setJoinError('Please enter a 6-letter room code or link.');
      return;
    }
    setJoinError('');
    router.push(`/room/${code.toUpperCase()}`);
  }

  return (
    <main className="min-h-screen bg-gray-900 flex flex-col items-center justify-center px-4 py-16">
      {/* Hero */}
      <div className="flex flex-col items-center gap-4 mb-10">
        <div className="flex items-center gap-3">
          <MusicWaveIcon />
          <h1 className="text-4xl font-extrabold tracking-tight text-white">
            Listen<span className="text-sky-400">2Gether</span>
          </h1>
        </div>
        <div className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-widest bg-sky-500/10 text-sky-400 border border-sky-500/20">
          L2G
        </div>
        <p className="text-gray-400 text-center max-w-xs text-sm leading-relaxed">
          Listen together in perfect sync — anywhere, any device.
        </p>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm space-y-6">
        {/* Create Room */}
        <div className="bg-gray-800 rounded-2xl p-6 space-y-3 border border-gray-700 shadow-xl">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span>🎵</span> Create a Room
          </h2>
          <p className="text-gray-400 text-xs">
            Start a new synchronized listening room and invite friends.
          </p>
          <button
            onClick={handleCreateRoom}
            disabled={isCreating}
            className="w-full bg-sky-500 hover:bg-sky-400 active:bg-sky-600 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-sky-900/40 cursor-pointer flex items-center justify-center gap-2"
          >
            {isCreating ? (
              <>
                <svg className="w-4 h-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Creating Room…
              </>
            ) : (
              'Create Room'
            )}
          </button>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray-800" />
          <span className="text-gray-500 text-xs font-medium">or join existing</span>
          <div className="flex-1 h-px bg-gray-800" />
        </div>

        {/* Join Room */}
        <div className="bg-gray-800 rounded-2xl p-6 space-y-4 border border-gray-700 shadow-xl">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span>🔗</span> Join a Room
          </h2>
          <div className="space-y-1">
            <input
              type="text"
              placeholder="e.g. ABCDEF or room link"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value);
                setJoinError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
              maxLength={100}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500 transition text-sm tracking-wider uppercase font-mono"
            />
            {joinError && (
              <p className="text-red-400 text-xs mt-1">{joinError}</p>
            )}
          </div>
          <button
            onClick={handleJoinRoom}
            className={`w-full font-semibold py-3.5 rounded-xl transition-all text-sm flex items-center justify-center gap-2 cursor-pointer ${
              isValidPattern
                ? 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-white shadow-lg shadow-emerald-900/40 ring-2 ring-emerald-400/30'
                : 'bg-gray-700 hover:bg-gray-600 active:bg-gray-800 text-gray-300'
            }`}
          >
            {isValidPattern && <span>✓</span>}
            Join Room
          </button>
        </div>
      </div>

      <p className="mt-12 text-gray-500 text-xs">
        No account needed. Powered by YouTube.
      </p>
    </main>
  );
}
