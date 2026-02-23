import { create } from 'zustand';

export type ClipStatus = 'pending' | 'generating' | 'done' | 'failed';

export type Clip = {
  id: string;
  imageUri: string;
  prompt: string;
  videoUri: string | null;
  lastFrameUri: string | null;
  status: ClipStatus;
  klingTaskId: string | null;
};

export type Phase = 'camera' | 'prompt' | 'generating' | 'preview';

type ClipStore = {
  clips: Clip[];
  phase: Phase;
  selectedImageUri: string | null;

  setPhase: (phase: Phase) => void;
  setSelectedImage: (uri: string) => void;

  addClip: (imageUri: string, prompt: string) => string;
  updateClip: (id: string, updates: Partial<Clip>) => void;

  getLastClip: () => Clip | null;
  getContextPrompt: (userPrompt: string) => string;

  reset: () => void;
};

export const useClipStore = create<ClipStore>((set, get) => ({
  clips: [],
  phase: 'camera',
  selectedImageUri: null,

  setPhase: (phase) => set({ phase }),
  setSelectedImage: (uri) => set({ selectedImageUri: uri }),

  addClip: (imageUri, prompt) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const fullPrompt = get().getContextPrompt(prompt);
    const clip: Clip = {
      id,
      imageUri,
      prompt,
      videoUri: null,
      lastFrameUri: null,
      status: 'generating',
      klingTaskId: null,
    };
    set((state) => ({ clips: [...state.clips, clip] }));
    return id;
  },

  updateClip: (id, updates) =>
    set((state) => ({
      clips: state.clips.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),

  getLastClip: () => {
    const { clips } = get();
    if (clips.length === 0) return null;
    return clips[clips.length - 1];
  },

  getContextPrompt: (userPrompt) => {
    const { clips } = get();
    const doneClips = clips.filter((c) => c.status === 'done');

    if (doneClips.length === 0) {
      return userPrompt;
    }

    // Last 2 prompts for context
    const recent = doneClips.slice(-2);

    if (recent.length === 1) {
      return [
        `Previous scene: "${recent[0].prompt}"`,
        `Current scene (continuing from the last frame): "${userPrompt}"`,
        'Maintain smooth visual and motion continuity.',
      ].join('\n');
    }

    return [
      `Two scenes ago: "${recent[0].prompt}"`,
      `Previous scene: "${recent[1].prompt}"`,
      `Current scene (continuing from the last frame): "${userPrompt}"`,
      'Maintain smooth visual and motion continuity.',
    ].join('\n');
  },

  reset: () => set({ clips: [], phase: 'camera', selectedImageUri: null }),
}));
