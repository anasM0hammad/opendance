import { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
  Dimensions,
  Modal,
  Animated,
  Easing,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as MediaLibrary from 'expo-media-library';
import { Video } from 'expo-av';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useClipStore, type Phase } from '../store/useClipStore';
import { generateVideo, pollUntilDone, downloadVideo } from '../services/api';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ---------------------------------------------------------------------------
// Custom Modal (replaces system Alert)
// ---------------------------------------------------------------------------
type ModalButton = {
  text: string;
  onPress: () => void;
  style?: 'cancel' | 'destructive' | 'default';
};

type ModalState = {
  visible: boolean;
  title: string;
  message?: string;
  buttons: ModalButton[];
};

function CustomModal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  if (!modal.visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.content}>
          <Text style={modalStyles.title}>{modal.title}</Text>
          {modal.message ? (
            <Text style={modalStyles.message}>{modal.message}</Text>
          ) : null}
          <View style={modalStyles.buttonRow}>
            {modal.buttons.map((btn, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  modalStyles.button,
                  btn.style === 'destructive' && modalStyles.buttonDestructive,
                  btn.style === 'cancel' && modalStyles.buttonCancel,
                ]}
                onPress={() => {
                  onClose();
                  btn.onPress();
                }}
              >
                <Text
                  style={[
                    modalStyles.buttonText,
                    btn.style === 'cancel' && modalStyles.buttonTextCancel,
                  ]}
                >
                  {btn.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  content: {
    backgroundColor: '#1c1c1e',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 320,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    color: '#999',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 22,
    lineHeight: 20,
  },
  buttonRow: {
    gap: 10,
  },
  button: {
    backgroundColor: '#6432ff',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  buttonDestructive: {
    backgroundColor: '#ff3b30',
  },
  buttonCancel: {
    backgroundColor: '#333',
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonTextCancel: {
    color: '#aaa',
  },
});

// ---------------------------------------------------------------------------
// Indeterminate Progress Bar
// ---------------------------------------------------------------------------
function ProgressBar() {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-(SCREEN_WIDTH * 0.35), SCREEN_WIDTH * 0.35],
  });

  return (
    <View style={progressStyles.track}>
      <Animated.View
        style={[progressStyles.bar, { transform: [{ translateX }] }]}
      />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    width: SCREEN_WIDTH * 0.55,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  bar: {
    width: '40%',
    height: '100%',
    backgroundColor: '#6432ff',
    borderRadius: 2,
  },
});

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------
export default function MainScreen() {
  const cameraRef = useRef<CameraView>(null);
  const videoRef = useRef<Video>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [cameraFacing, setCameraFacing] = useState<'front' | 'back'>('back');
  const [prompt, setPrompt] = useState('');
  const [genStatus, setGenStatus] = useState('Starting...');
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState(0);
  const [playbackKey, setPlaybackKey] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [modal, setModal] = useState<ModalState>({
    visible: false,
    title: '',
    buttons: [],
  });

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

  // ---- Helpers ----

  const showModal = useCallback(
    (title: string, message: string | undefined, buttons: ModalButton[]) => {
      setModal({ visible: true, title, message, buttons });
    },
    [],
  );

  const hideModal = useCallback(() => {
    setModal((prev) => ({ ...prev, visible: false }));
  }, []);

  // ---- Permissions ----

  useEffect(() => {
    if (!cameraPermission?.granted) {
      requestCameraPermission();
    }
  }, []);

  // ---- Camera actions ----

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

  const toggleCameraFacing = useCallback(() => {
    setCameraReady(false);
    setCameraFacing((prev) => (prev === 'back' ? 'front' : 'back'));
  }, []);

  // ---- Generation ----

  const startGeneration = useCallback(async () => {
    if (!selectedImageUri || !prompt.trim()) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const fullPrompt = getContextPrompt(prompt.trim());
    const clipId = addClip(selectedImageUri, prompt.trim());
    setPhase('generating');
    setGenStatus('Uploading image...');

    try {
      setGenStatus('Starting generation...');
      const { taskId } = await generateVideo(
        selectedImageUri,
        fullPrompt,
        controller.signal,
      );
      updateClip(clipId, { klingTaskId: taskId });

      setGenStatus('Generating video...');
      const videoUrl = await pollUntilDone(
        taskId,
        (status) => {
          setGenStatus(
            status === 'processing' ? 'Generating video...' : status,
          );
        },
        controller.signal,
      );

      setGenStatus('Downloading video...');
      const localVideoUri = await downloadVideo(videoUrl, clipId);

      const thumbnail = await VideoThumbnails.getThumbnailAsync(
        localVideoUri,
        { time: 4900 },
      );

      updateClip(clipId, {
        videoUri: localVideoUri,
        lastFrameUri: thumbnail.uri,
        status: 'done',
      });

      setPrompt('');
      const latestDoneClips = useClipStore
        .getState()
        .clips.filter((c) => c.status === 'done');
      setCurrentPlayingIndex(latestDoneClips.length - 1);
      setPhase('preview');
    } catch (error) {
      updateClip(clipId, { status: 'failed' });
      if (!controller.signal.aborted) {
        showModal(
          'Generation Failed',
          error instanceof Error
            ? error.message
            : 'Something went wrong. Please try again.',
          [{ text: 'OK', onPress: () => {}, style: 'default' }],
        );
      }
      setPhase('prompt');
    } finally {
      abortControllerRef.current = null;
    }
  }, [selectedImageUri, prompt, getContextPrompt, addClip, updateClip]);

  const cancelGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // ---- Preview actions ----

  const handleAddNextClip = useCallback(() => {
    const last = getLastClip();
    if (last?.lastFrameUri) {
      setSelectedImage(last.lastFrameUri);
      setPhase('prompt');
    } else {
      setPhase('camera');
    }
  }, [getLastClip]);

  const handleRetry = useCallback(() => {
    setPhase('prompt');
  }, []);

  const saveClipToGallery = useCallback(
    async (videoUri: string) => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        showModal(
          'Permission Needed',
          'Grant media library access to save videos.',
          [{ text: 'OK', onPress: () => {}, style: 'default' }],
        );
        return;
      }
      await MediaLibrary.saveToLibraryAsync(videoUri);
      showModal('Saved!', 'Video has been saved to your gallery.', [
        { text: 'Great', onPress: () => {}, style: 'default' },
      ]);
    },
    [showModal],
  );

  const onVideoEnd = useCallback(() => {
    const doneClips = clips.filter((c) => c.status === 'done');
    if (currentPlayingIndex < doneClips.length - 1) {
      setCurrentPlayingIndex(currentPlayingIndex + 1);
    }
  }, [clips, currentPlayingIndex]);

  const playAll = useCallback(() => {
    setCurrentPlayingIndex(0);
    setPlaybackKey((k) => k + 1);
  }, []);

  // =======================================================================
  // RENDER
  // =======================================================================

  // ---- Camera Phase ----
  if (phase === 'camera') {
    if (!cameraPermission?.granted) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.centered}>
            <Text style={styles.permissionTitle}>Camera Access</Text>
            <Text style={styles.permissionText}>
              Camera permission is required to capture scenes
            </Text>
            <TouchableOpacity
              style={styles.permissionBtn}
              onPress={requestCameraPermission}
            >
              <Text style={styles.permissionBtnText}>Grant Permission</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <View style={styles.container}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={cameraFacing}
          onCameraReady={() => setCameraReady(true)}
        >
          {/* Loading overlay while camera initialises */}
          {!cameraReady && (
            <View style={styles.cameraLoading}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.cameraLoadingText}>Starting camera...</Text>
            </View>
          )}

          {/* Top bar: title + flip button */}
          <SafeAreaView style={styles.cameraTopBar}>
            <View style={styles.cameraTopBarInner}>
              <Text style={styles.cameraTitle}>
                {clips.length === 0
                  ? 'Capture your first scene'
                  : 'Capture next scene'}
              </Text>
              <TouchableOpacity
                style={styles.flipBtn}
                onPress={toggleCameraFacing}
                activeOpacity={0.7}
              >
                <Text style={styles.flipBtnIcon}>{'↻'}</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>

          {/* Bottom controls */}
          <View style={styles.cameraControls}>
            <TouchableOpacity
              style={styles.galleryBtn}
              onPress={pickFromGallery}
            >
              <Text style={styles.galleryBtnText}>Gallery</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.captureBtn} onPress={takePicture}>
              <View style={styles.captureBtnInner} />
            </TouchableOpacity>
            {getLastClip()?.lastFrameUri ? (
              <TouchableOpacity
                style={styles.lastFrameCameraBtn}
                onPress={useLastFrame}
              >
                <Text style={styles.lastFrameCameraBtnText}>
                  Last{'\n'}Frame
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.cameraControlSpacer} />
            )}
          </View>
        </CameraView>
      </View>
    );
  }

  // ---- Prompt Phase ----
  if (phase === 'prompt') {
    const lastClip = getLastClip();
    const isFirstClip =
      clips.filter((c) => c.status === 'done').length === 0;
    const usingLastFrame =
      !isFirstClip && selectedImageUri === lastClip?.lastFrameUri;

    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Image — takes all remaining space */}
        <View style={styles.promptImageSection}>
          {selectedImageUri && (
            <Image
              source={{ uri: selectedImageUri }}
              style={styles.promptImage}
              resizeMode="cover"
            />
          )}
          {usingLastFrame && (
            <View style={styles.lastFrameBadge}>
              <Text style={styles.lastFrameBadgeText}>Last frame</Text>
            </View>
          )}
          {/* Overlay option chips on the image */}
          <View style={styles.imageOptionsOverlay}>
            <TouchableOpacity
              style={styles.imageOptionBtn}
              onPress={() => setPhase('camera')}
            >
              <Text style={styles.imageOptionBtnText}>
                {usingLastFrame ? 'Camera' : 'Retake'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.imageOptionBtn}
              onPress={pickFromGallery}
            >
              <Text style={styles.imageOptionBtnText}>Gallery</Text>
            </TouchableOpacity>
            {!isFirstClip && !usingLastFrame && lastClip?.lastFrameUri && (
              <TouchableOpacity
                style={styles.imageOptionBtnHighlight}
                onPress={useLastFrame}
              >
                <Text style={styles.imageOptionBtnHighlightText}>
                  Last Frame
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Bottom — prompt input + generate button */}
        <View style={styles.promptBottomSection}>
          <Text style={styles.promptTitle}>
            {isFirstClip
              ? 'Describe the scene'
              : `Clip ${clips.filter((c) => c.status === 'done').length + 1}`}
          </Text>

          {!isFirstClip && lastClip?.prompt ? (
            <Text style={styles.contextHintText} numberOfLines={1}>
              Previous: &quot;{lastClip.prompt}&quot;
            </Text>
          ) : null}

          <TextInput
            style={styles.promptInput}
            placeholder="Describe what happens in this scene..."
            placeholderTextColor="#555"
            value={prompt}
            onChangeText={setPrompt}
            multiline
          />

          <TouchableOpacity
            style={[
              styles.generateBtn,
              !prompt.trim() && styles.generateBtnDisabled,
            ]}
            onPress={startGeneration}
            disabled={!prompt.trim()}
          >
            <Text style={styles.generateBtnText}>Generate Video</Text>
          </TouchableOpacity>
        </View>

        <CustomModal modal={modal} onClose={hideModal} />
      </KeyboardAvoidingView>
    );
  }

  // ---- Generating Phase ----
  if (phase === 'generating') {
    return (
      <View style={styles.container}>
        {/* Full-screen image background */}
        {selectedImageUri && (
          <Image
            source={{ uri: selectedImageUri }}
            style={styles.fullScreenMedia}
            resizeMode="cover"
          />
        )}

        {/* Semi-transparent overlay */}
        <View style={styles.genOverlay}>
          {/* Centered progress info */}
          <View style={styles.genCenter}>
            <Text style={styles.genStatusText}>{genStatus}</Text>
            <ProgressBar />
            <Text style={styles.genHintText}>
              Usually takes 30–90 seconds
            </Text>
          </View>

          {/* Cancel button at bottom */}
          <SafeAreaView style={styles.genBottom}>
            <TouchableOpacity
              style={styles.genCancelBtn}
              onPress={cancelGeneration}
              activeOpacity={0.7}
            >
              <Text style={styles.genCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </SafeAreaView>
        </View>

        <CustomModal modal={modal} onClose={hideModal} />
      </View>
    );
  }

  // ---- Preview Phase ----
  const doneClips = clips.filter((c) => c.status === 'done' && c.videoUri);
  const currentClip = doneClips[currentPlayingIndex];

  return (
    <View style={styles.container}>
      {/* Full-screen video */}
      {currentClip?.videoUri && (
        <Video
          key={`${currentClip.id}-${playbackKey}`}
          ref={videoRef}
          source={{ uri: currentClip.videoUri }}
          style={styles.fullScreenMedia}
          resizeMode={'cover' as any}
          shouldPlay
          isLooping
          onPlaybackStatusUpdate={(status) => {
            if (status.isLoaded && status.didJustFinish) {
              onVideoEnd();
            }
          }}
        />
      )}

      {/* Overlay controls */}
      <View style={styles.previewOverlay}>
        {/* Top */}
        <SafeAreaView style={styles.previewTop}>
          {doneClips.length > 1 && (
            <View style={styles.clipCounterPill}>
              <Text style={styles.clipCounterText}>
                Clip {currentPlayingIndex + 1} of {doneClips.length}
              </Text>
            </View>
          )}
        </SafeAreaView>

        {/* Thumbnail strip (only when > 1 clip) */}
        {doneClips.length > 1 && (
          <ScrollView
            horizontal
            style={styles.thumbnailStrip}
            contentContainerStyle={styles.thumbnailStripContent}
            showsHorizontalScrollIndicator={false}
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

        {/* Bottom action buttons */}
        <SafeAreaView style={styles.previewBottom}>
          <View style={styles.previewBottomInner}>
            {/* Primary row */}
            <View style={styles.previewPrimaryRow}>
              <TouchableOpacity
                style={styles.previewRetryBtn}
                onPress={handleRetry}
              >
                <Text style={styles.previewRetryBtnText}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.previewNextBtn}
                onPress={handleAddNextClip}
              >
                <Text style={styles.previewNextBtnText}>+ Next Scene</Text>
              </TouchableOpacity>
            </View>

            {/* Secondary row */}
            <View style={styles.previewSecondaryRow}>
              {doneClips.length > 1 && (
                <TouchableOpacity
                  style={styles.previewSecBtn}
                  onPress={playAll}
                >
                  <Text style={styles.previewSecBtnText}>Play All</Text>
                </TouchableOpacity>
              )}
              {currentClip?.videoUri && (
                <TouchableOpacity
                  style={styles.previewSecBtn}
                  onPress={() => saveClipToGallery(currentClip.videoUri!)}
                >
                  <Text style={styles.previewSecBtnText}>Save</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.previewSecBtn}
                onPress={() => {
                  showModal(
                    'Start Over',
                    'This will clear all clips. Are you sure?',
                    [
                      {
                        text: 'Cancel',
                        onPress: () => {},
                        style: 'cancel',
                      },
                      {
                        text: 'Start Over',
                        onPress: () => reset(),
                        style: 'destructive',
                      },
                    ],
                  );
                }}
              >
                <Text style={styles.previewStartOverText}>Start Over</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </View>

      <CustomModal modal={modal} onClose={hideModal} />
    </View>
  );
}

// ==========================================================================
// Styles
// ==========================================================================

const styles = StyleSheet.create({
  // -- Shared --
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },

  // -- Permission screen --
  permissionTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 10,
  },
  permissionText: {
    color: '#888',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 22,
  },
  permissionBtn: {
    backgroundColor: '#6432ff',
    paddingHorizontal: 36,
    paddingVertical: 15,
    borderRadius: 16,
  },
  permissionBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // -- Camera --
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
  cameraTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
  },
  cameraTopBarInner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  cameraTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  flipBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  flipBtnIcon: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '600',
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
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureBtnInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff',
  },
  galleryBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 22,
  },
  galleryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  lastFrameCameraBtn: {
    backgroundColor: 'rgba(100,50,255,0.5)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
  },
  lastFrameCameraBtnText: {
    color: '#fff',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 16,
    fontWeight: '500',
  },
  cameraControlSpacer: {
    width: 64,
  },

  // -- Prompt --
  promptImageSection: {
    flex: 1,
    backgroundColor: '#111',
  },
  promptImage: {
    width: '100%',
    height: '100%',
  },
  lastFrameBadge: {
    position: 'absolute',
    top: 52,
    right: 16,
    backgroundColor: 'rgba(100,50,255,0.85)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
  },
  lastFrameBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  imageOptionsOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  imageOptionBtn: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  imageOptionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  imageOptionBtnHighlight: {
    backgroundColor: 'rgba(100,50,255,0.55)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(100,50,255,0.8)',
  },
  imageOptionBtnHighlightText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  promptBottomSection: {
    backgroundColor: '#0a0a0a',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: Platform.OS === 'ios' ? 32 : 18,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: -16,
  },
  promptTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  contextHintText: {
    color: '#666',
    fontSize: 12,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  promptInput: {
    backgroundColor: '#1a1a1a',
    color: '#fff',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 52,
    maxHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  generateBtn: {
    backgroundColor: '#6432ff',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  generateBtnDisabled: {
    opacity: 0.35,
  },
  generateBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // -- Generating --
  fullScreenMedia: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  genOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'space-between',
  },
  genCenter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
  },
  genStatusText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  genHintText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
  },
  genBottom: {
    alignItems: 'center',
    paddingBottom: 24,
  },
  genCancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 44,
    paddingVertical: 14,
    borderRadius: 26,
  },
  genCancelBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  // -- Preview --
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
  },
  previewTop: {
    alignItems: 'center',
    paddingTop: 8,
  },
  clipCounterPill: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  clipCounterText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '500',
  },
  thumbnailStrip: {
    position: 'absolute',
    top: 90,
    left: 0,
    right: 0,
    maxHeight: 54,
  },
  thumbnailStripContent: {
    gap: 6,
    paddingHorizontal: 14,
  },
  thumbnail: {
    width: 48,
    height: 48,
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
    bottom: 1,
    right: 3,
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  previewBottom: {
    paddingBottom: 8,
  },
  previewBottomInner: {
    paddingHorizontal: 16,
    gap: 10,
  },
  previewPrimaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  previewRetryBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 15,
    borderRadius: 16,
    alignItems: 'center',
  },
  previewRetryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  previewNextBtn: {
    flex: 2,
    backgroundColor: '#6432ff',
    paddingVertical: 15,
    borderRadius: 16,
    alignItems: 'center',
  },
  previewNextBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  previewSecondaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  previewSecBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 11,
    borderRadius: 14,
    alignItems: 'center',
  },
  previewSecBtnText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 13,
    fontWeight: '500',
  },
  previewStartOverText: {
    color: 'rgba(255,100,100,0.7)',
    fontSize: 13,
    fontWeight: '500',
  },
});
