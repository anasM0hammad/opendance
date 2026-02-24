import { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Image,
  Alert,
  Dimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as MediaLibrary from 'expo-media-library';
// Issue 12 fix: Import only Video — use string literal for resizeMode
// to avoid depending on the potentially deprecated ResizeMode enum.
import { Video } from 'expo-av';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useClipStore, type Phase } from '../store/useClipStore';
import { generateVideo, pollUntilDone, downloadVideo } from '../services/api';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function MainScreen() {
  const cameraRef = useRef<CameraView>(null);
  const videoRef = useRef<Video>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [prompt, setPrompt] = useState('');
  const [genStatus, setGenStatus] = useState('Starting...');
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState(0);
  // Issue 7 fix: playbackKey forces Video remount when "Play All" is pressed
  // while already at index 0, which would otherwise be a no-op.
  const [playbackKey, setPlaybackKey] = useState(0);
  // Issue 14 fix: Track camera readiness to show a loading indicator
  // while the camera stream initializes.
  const [cameraReady, setCameraReady] = useState(false);

  const {
    clips,
    phase,
    selectedImageUri,
    setPhase,
    setSelectedImage,
    addClip,
    updateClip,
    getLastClip,
    getContextPrompt,
    reset,
  } = useClipStore();

  // Request camera permission on mount
  useEffect(() => {
    if (!cameraPermission?.granted) {
      requestCameraPermission();
    }
  }, []);

  // Issue 16 fix: Reduced image quality from 0.7 to 0.5 to lower memory
  // usage during base64 encoding and speed up uploads.
  const takePicture = useCallback(async () => {
    if (!cameraRef.current) return;
    const photo = await cameraRef.current.takePictureAsync({ quality: 0.5 });
    if (photo) {
      setSelectedImage(photo.uri);
      setPhase('prompt');
    }
  }, []);

  const pickFromGallery = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.5,
    });
    if (!result.canceled && result.assets[0]) {
      setSelectedImage(result.assets[0].uri);
      setPhase('prompt');
    }
  }, []);

  const useLastFrame = useCallback(() => {
    const last = getLastClip();
    if (last?.lastFrameUri) {
      setSelectedImage(last.lastFrameUri);
      setPhase('prompt');
    }
  }, [getLastClip]);

  const startGeneration = useCallback(async () => {
    if (!selectedImageUri || !prompt.trim()) return;

    // Issue 4 fix: Create an AbortController so the user can cancel generation
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const fullPrompt = getContextPrompt(prompt.trim());
    const clipId = addClip(selectedImageUri, prompt.trim());
    setPhase('generating');
    setGenStatus('Uploading image...');

    try {
      // 1. Call worker to start generation
      setGenStatus('Starting generation...');
      const { taskId } = await generateVideo(selectedImageUri, fullPrompt, controller.signal);
      updateClip(clipId, { klingTaskId: taskId });

      // 2. Poll until done (with timeout and abort support — Issue 3)
      setGenStatus('Generating video...');
      const videoUrl = await pollUntilDone(taskId, (status) => {
        setGenStatus(
          status === 'processing' ? 'Generating video...' : status,
        );
      }, controller.signal);

      // 3. Download video to device
      setGenStatus('Downloading video...');
      const localVideoUri = await downloadVideo(videoUrl, clipId);

      // 4. Extract last frame
      const thumbnail = await VideoThumbnails.getThumbnailAsync(localVideoUri, {
        time: 4900, // Near the end of 5s clip
      });

      updateClip(clipId, {
        videoUri: localVideoUri,
        lastFrameUri: thumbnail.uri,
        status: 'done',
      });

      setPrompt('');
      // Issue 1 fix: Read the latest clip count from the store directly
      // instead of using the stale `clips.length` from the closure.
      const latestDoneClips = useClipStore.getState().clips.filter(
        (c) => c.status === 'done',
      );
      setCurrentPlayingIndex(latestDoneClips.length - 1);
      setPhase('preview');
    } catch (error) {
      updateClip(clipId, { status: 'failed' });
      // Don't show an alert if the user intentionally cancelled
      if (!controller.signal.aborted) {
        Alert.alert('Error', error instanceof Error ? error.message : 'Generation failed');
      }
      setPhase('prompt');
    } finally {
      abortControllerRef.current = null;
    }
  }, [selectedImageUri, prompt, getContextPrompt, addClip, updateClip]);

  // Issue 4 fix: Cancel handler aborts the in-flight generation and
  // returns to the prompt phase.
  const cancelGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const handleAddNextClip = useCallback(() => {
    const last = getLastClip();
    if (last?.lastFrameUri) {
      // Default to last frame for continuity
      setSelectedImage(last.lastFrameUri);
      setPhase('prompt');
    } else {
      setPhase('camera');
    }
  }, [getLastClip]);

  const saveClipToGallery = useCallback(async (videoUri: string) => {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Grant media library access to save videos.');
      return;
    }
    await MediaLibrary.saveToLibraryAsync(videoUri);
    Alert.alert('Saved', 'Video saved to gallery.');
  }, []);

  // Handle sequential playback
  const onVideoEnd = useCallback(() => {
    const doneClips = clips.filter((c) => c.status === 'done');
    if (currentPlayingIndex < doneClips.length - 1) {
      setCurrentPlayingIndex(currentPlayingIndex + 1);
    }
  }, [clips, currentPlayingIndex]);

  // Issue 7 fix: Increment playbackKey to force Video remount even when
  // already at index 0, making "Play All" always restart from the beginning.
  const playAll = useCallback(() => {
    setCurrentPlayingIndex(0);
    setPlaybackKey((k) => k + 1);
  }, []);

  // --- RENDER ---

  // Camera phase
  if (phase === 'camera') {
    if (!cameraPermission?.granted) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.centered}>
            <Text style={styles.text}>Camera permission is required</Text>
            <TouchableOpacity style={styles.button} onPress={requestCameraPermission}>
              <Text style={styles.buttonText}>Grant Permission</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <SafeAreaView style={styles.container}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="back"
          onCameraReady={() => setCameraReady(true)}
        >
          {/* Issue 14 fix: Show loading indicator until camera stream is active */}
          {!cameraReady && (
            <View style={styles.cameraLoading}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.cameraLoadingText}>Starting camera...</Text>
            </View>
          )}
          <View style={styles.cameraOverlay}>
            <Text style={styles.title}>
              {clips.length === 0 ? 'Capture your first scene' : 'Capture next scene'}
            </Text>
          </View>
          <View style={styles.cameraControls}>
            <TouchableOpacity style={styles.galleryBtn} onPress={pickFromGallery}>
              <Text style={styles.galleryBtnText}>Gallery</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.captureBtn} onPress={takePicture}>
              <View style={styles.captureBtnInner} />
            </TouchableOpacity>
            <View style={{ width: 60 }} />
          </View>
        </CameraView>
      </SafeAreaView>
    );
  }

  // Prompt phase
  if (phase === 'prompt') {
    const lastClip = getLastClip();
    const isFirstClip = clips.filter((c) => c.status === 'done').length === 0;
    const usingLastFrame = !isFirstClip && selectedImageUri === lastClip?.lastFrameUri;

    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.promptContainer}>
          <Text style={styles.title}>
            {isFirstClip ? 'Describe the scene' : `Clip ${clips.filter((c) => c.status === 'done').length + 1}`}
          </Text>

          {/* Image preview */}
          {selectedImageUri && (
            <View style={styles.imagePreviewContainer}>
              <Image source={{ uri: selectedImageUri }} style={styles.imagePreview} />
              {usingLastFrame && (
                <View style={styles.lastFrameBadge}>
                  <Text style={styles.lastFrameBadgeText}>Last frame</Text>
                </View>
              )}
            </View>
          )}

          {/* Change image options */}
          <View style={styles.imageOptions}>
            {!isFirstClip && !usingLastFrame && lastClip?.lastFrameUri && (
              <TouchableOpacity style={styles.smallBtn} onPress={useLastFrame}>
                <Text style={styles.smallBtnText}>Use last frame</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setPhase('camera')}
            >
              <Text style={styles.smallBtnText}>
                {usingLastFrame ? 'Use camera instead' : 'Retake'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.smallBtn} onPress={pickFromGallery}>
              <Text style={styles.smallBtnText}>Gallery</Text>
            </TouchableOpacity>
          </View>

          {/* Context hint */}
          {!isFirstClip && (
            <View style={styles.contextHint}>
              <Text style={styles.contextHintText}>
                Previous: "{lastClip?.prompt}"
              </Text>
            </View>
          )}

          {/* Prompt input */}
          <TextInput
            style={styles.promptInput}
            placeholder="Describe what happens in this scene..."
            placeholderTextColor="#666"
            value={prompt}
            onChangeText={setPrompt}
            multiline
            autoFocus
          />

          <TouchableOpacity
            style={[styles.button, !prompt.trim() && styles.buttonDisabled]}
            onPress={startGeneration}
            disabled={!prompt.trim()}
          >
            <Text style={styles.buttonText}>Generate Video</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Generating phase
  // Issue 4 fix: Added a Cancel button so the user is not trapped during generation.
  if (phase === 'generating') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          {selectedImageUri && (
            <Image
              source={{ uri: selectedImageUri }}
              style={styles.genPreviewImage}
            />
          )}
          <ActivityIndicator size="large" color="#fff" style={{ marginTop: 24 }} />
          <Text style={styles.genStatusText}>{genStatus}</Text>
          <Text style={styles.genHintText}>
            This usually takes 30-90 seconds
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={cancelGeneration}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Preview phase
  const doneClips = clips.filter((c) => c.status === 'done' && c.videoUri);
  const currentClip = doneClips[currentPlayingIndex];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.previewContainer}>
        <Text style={styles.title}>
          {doneClips.length === 1
            ? 'Your clip'
            : `Playing clip ${currentPlayingIndex + 1} of ${doneClips.length}`}
        </Text>

        {/* Video player */}
        {/* Issue 8 fix: key prop forces React to unmount/remount the Video
            component when the clip changes, ensuring fresh playback.
            Issue 7: playbackKey is included so "Play All" also forces a remount. */}
        {currentClip?.videoUri && (
          <Video
            key={`${currentClip.id}-${playbackKey}`}
            ref={videoRef}
            source={{ uri: currentClip.videoUri }}
            style={styles.videoPlayer}
            resizeMode={"contain" as any}
            shouldPlay
            onPlaybackStatusUpdate={(status) => {
              if (status.isLoaded && status.didJustFinish) {
                onVideoEnd();
              }
            }}
          />
        )}

        {/* Clip thumbnails */}
        {doneClips.length > 1 && (
          <ScrollView
            horizontal
            style={styles.thumbnailStrip}
            contentContainerStyle={styles.thumbnailStripContent}
          >
            {doneClips.map((clip, idx) => (
              <TouchableOpacity
                key={clip.id}
                onPress={() => setCurrentPlayingIndex(idx)}
                style={[
                  styles.thumbnail,
                  idx === currentPlayingIndex && styles.thumbnailActive,
                ]}
              >
                <Image
                  source={{ uri: clip.imageUri }}
                  style={styles.thumbnailImage}
                />
                <Text style={styles.thumbnailLabel}>{idx + 1}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Actions */}
        <View style={styles.previewActions}>
          {doneClips.length > 1 && (
            <TouchableOpacity style={styles.secondaryBtn} onPress={playAll}>
              <Text style={styles.secondaryBtnText}>Play All</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.button} onPress={handleAddNextClip}>
            <Text style={styles.buttonText}>+ Next Clip</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.previewActions}>
          {currentClip?.videoUri && (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => saveClipToGallery(currentClip.videoUri!)}
            >
              <Text style={styles.secondaryBtnText}>Save to Gallery</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.dangerBtn}
            onPress={() => {
              Alert.alert('Start Over', 'This will clear all clips.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Start Over',
                  style: 'destructive',
                  onPress: () => reset(),
                },
              ]);
            }}
          >
            <Text style={styles.dangerBtnText}>Start Over</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// --- Styles ---

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  text: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 16,
  },

  // Camera
  camera: {
    flex: 1,
  },
  cameraLoading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 10,
  },
  cameraLoadingText: {
    color: '#fff',
    fontSize: 14,
    marginTop: 12,
  },
  cameraOverlay: {
    paddingTop: 20,
    alignItems: 'center',
  },
  cameraControls: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureBtnInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
  },
  galleryBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  galleryBtnText: {
    color: '#fff',
    fontSize: 14,
  },

  // Prompt
  promptContainer: {
    padding: 20,
    paddingTop: 16,
  },
  imagePreviewContainer: {
    alignItems: 'center',
    marginBottom: 12,
  },
  imagePreview: {
    width: SCREEN_WIDTH - 40,
    height: (SCREEN_WIDTH - 40) * 0.6,
    borderRadius: 12,
    backgroundColor: '#111',
  },
  lastFrameBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(100,50,255,0.8)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  lastFrameBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  imageOptions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
  },
  smallBtn: {
    backgroundColor: '#222',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  smallBtnText: {
    color: '#aaa',
    fontSize: 13,
  },
  contextHint: {
    backgroundColor: '#111',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  contextHintText: {
    color: '#888',
    fontSize: 13,
    fontStyle: 'italic',
  },
  promptInput: {
    backgroundColor: '#111',
    color: '#fff',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 20,
  },

  // Buttons
  button: {
    backgroundColor: '#6432ff',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#222',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  dangerBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#444',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  dangerBtnText: {
    color: '#888',
    fontSize: 14,
  },
  cancelBtn: {
    marginTop: 24,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#666',
  },
  cancelBtnText: {
    color: '#ccc',
    fontSize: 15,
    fontWeight: '600',
  },

  // Generating
  genPreviewImage: {
    width: SCREEN_WIDTH * 0.6,
    height: SCREEN_WIDTH * 0.6 * 0.75,
    borderRadius: 12,
    backgroundColor: '#111',
  },
  genStatusText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 16,
  },
  genHintText: {
    color: '#666',
    fontSize: 13,
    marginTop: 8,
  },

  // Preview
  previewContainer: {
    flex: 1,
    padding: 16,
    paddingTop: 8,
  },
  videoPlayer: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
    backgroundColor: '#111',
  },
  thumbnailStrip: {
    marginTop: 12,
    maxHeight: 72,
  },
  thumbnailStripContent: {
    gap: 8,
    paddingHorizontal: 4,
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbnailActive: {
    borderColor: '#6432ff',
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  thumbnailLabel: {
    position: 'absolute',
    bottom: 2,
    right: 4,
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
});
