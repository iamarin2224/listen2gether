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
  const [displayName, setDisplayName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [nameError, setNameError] = useState('');
  const [joinError, setJoinError] = useState('');

  const parsedCode = parseRoomCode(joinCode);
  const isValidPattern = /^[A-Za-z0-9]{6}$/.test(parsedCode);

  async function handleCreateRoom() {
    const name = displayName.trim();
    if (!name) {
      setNameError('Please enter your display name first.');
      return;
    }
    setNameError('');
    const slug = generateRoomCode();
    sessionStorage.setItem('syncwave_displayName', name);
    sessionStorage.setItem(`syncwave_created_${slug}`, 'true');
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
    const name = displayName.trim();
    if (!name) {
      setNameError('Please enter your display name first.');
      return;
    }
    setNameError('');

    const code = parseRoomCode(joinCode);
    if (!code) {
      setJoinError('Please enter a room code or link.');
      return;
    }
    setJoinError('');
    sessionStorage.setItem('syncwave_displayName', name);
    router.push(`/room/${code}`);
  }

  return (
    <main className="min-h-screen bg-gray-900 flex flex-col items-center justify-center px-4 py-16">
      {/* Hero */}
      <div className="flex flex-col items-center gap-4 mb-12">
        <div className="flex items-center gap-3">
          <MusicWaveIcon />
          <h1 className="text-4xl font-extrabold tracking-tight text-white">
            Sync<span className="text-sky-400">Wave</span>
          </h1>
        </div>
        <p className="text-gray-400 text-center max-w-xs text-sm leading-relaxed">
          Listen together in perfect sync — anywhere, any device.
        </p>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm space-y-6">
        {/* Display Name */}
        <div className="space-y-1">
          <label
            htmlFor="displayName"
            className="block text-xs font-semibold text-gray-400 uppercase tracking-wider"
          >
            Your Display Name
          </label>
          <input
            id="displayName"
            type="text"
            placeholder="e.g. Alice"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setNameError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateRoom()}
            maxLength={30}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500 transition text-sm"
          />
          {nameError && (
            <p className="text-red-400 text-xs mt-1">{nameError}</p>
          )}
        </div>

        {/* Create Room */}
        <div className="bg-gray-800 rounded-2xl p-5 space-y-3 border border-gray-700">
          <h2 className="text-sm font-bold text-white">🎵 Create a Room</h2>
          <p className="text-gray-400 text-xs">
            Start a new listening session and invite friends.
          </p>
          <button
            onClick={handleCreateRoom}
            className="w-full bg-sky-500 hover:bg-sky-400 active:bg-sky-600 text-white font-semibold py-3 rounded-xl transition-colors text-sm shadow-lg shadow-sky-900/40"
          >
            Create Room
          </button>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray-700" />
          <span className="text-gray-500 text-xs font-medium">or join existing</span>
          <div className="flex-1 h-px bg-gray-700" />
        </div>

        {/* Join Room */}
        <div className="bg-gray-800 rounded-2xl p-5 space-y-3 border border-gray-700">
          <h2 className="text-sm font-bold text-white">🔗 Join a Room</h2>
          <input
            type="text"
            placeholder="Room code or link"
            value={joinCode}
            onChange={(e) => {
              setJoinCode(e.target.value);
              setJoinError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500 transition text-sm"
          />
          {joinError && (
            <p className="text-red-400 text-xs">{joinError}</p>
          )}
          <button
            onClick={handleJoinRoom}
            className={`w-full font-semibold py-3 rounded-xl transition-all text-sm flex items-center justify-center gap-2 ${
              isValidPattern
                ? 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-white shadow-lg shadow-emerald-900/40 cursor-pointer'
                : 'bg-gray-700 hover:bg-gray-600 active:bg-gray-800 text-gray-300'
            }`}
          >
            {isValidPattern && <span>✓</span>}
            Join Room
          </button>
        </div>
      </div>

      <p className="mt-12 text-gray-600 text-xs">
        No account needed. Music powered by YouTube.
      </p>
    </main>
  );
}
