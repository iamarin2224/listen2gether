export interface Track {
  videoId: string;
  title: string;
  artist: string;
  duration: number; // seconds
  thumbnail: string;
}

export interface RoomState {
  roomId: string;
  currentTrack: Track | null;
  queue: Track[];
  isPlaying: boolean;
  anchorTime: number;      // seconds into the track
  anchorTimestamp: number; // epoch ms when anchorTime was set
  listeners: string[];     // list of display names / socket IDs
}
