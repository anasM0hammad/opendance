import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';

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

export const useClipStore = create<ClipStore>()(
  persist(
    (set, get) => ({
      clips: [],
      phase: 'camera',
      selectedImageUri: null,

      setPhase: (phase) => set({ phase }),
      setSelectedImage: (uri) => set({ selectedImageUri: uri }),

      addClip: (imageUri, prompt) => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        // Issue 2 fix: Removed dead getContextPrompt call.
        // Prompt enrichment is handled at the call site in index.tsx.
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

      // Issue 5 fix: Return the last clip with status 'done' instead of
      // the last clip by array position. This ensures continuity chaining
      // works correctly even after a failed generation.
      getLastClip: () => {
        const { clips } = get();
        const doneClips = clips.filter((c) => c.status === 'done');
        if (doneClips.length === 0) return null;
        return doneClips[doneClips.length - 1];
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

      // Issue 17 fix: Clean up cached video and thumbnail files on reset.
      reset: () => {
        const { clips } = get();
        for (const clip of clips) {
          try {
            if (clip.videoUri) new File(clip.videoUri).delete();
          } catch { /* ignore cleanup errors */ }
          try {
            if (clip.lastFrameUri) new File(clip.lastFrameUri).delete();
          } catch { /* ignore cleanup errors */ }
        }
        set({ clips: [], phase: 'camera', selectedImageUri: null });
      },
    }),
    {
      // Issue 6 fix: Persist clip data to AsyncStorage so clips survive
      // app restarts and OS background kills.
      name: 'opendance-clips',
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist completed clips — generating/failed clips are transient
      partialize: (state) => ({
        clips: state.clips.filter((c) => c.status === 'done'),
      }),
      onRehydrateStorage: () => {
        return (state, error) => {
          if (!error && state) {
            const doneClips = state.clips.filter((c) => c.status === 'done');
            if (doneClips.length > 0) {
              // Restore to preview phase if there are completed clips
              useClipStore.setState({ phase: 'preview' });
            }
          }
        };
      },
    },
  ),
);
