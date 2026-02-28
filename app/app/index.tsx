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
  BackHandler,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as MediaLibrary from 'expo-media-library';
import { Video } from 'expo-av';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useClipStore, type Phase } from '../store/useClipStore';
import { generateVideo, pollUntilDone, downloadVideo } from '../services/api';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MAX_CLIPS = 5;

// ---------------------------------------------------------------------------
// Custom Modal
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
  buttonRow: { gap: 10 },
  button: {
    backgroundColor: '#6432ff',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  buttonDestructive: { backgroundColor: '#ff3b30' },
  buttonCancel: { backgroundColor: '#333' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  buttonTextCancel: { color: '#aaa' },
});

// ---------------------------------------------------------------------------
// Progress Bar
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
// Back Button
// ---------------------------------------------------------------------------
function BackButton({
  onPress,
  topOffset,
}: {
  onPress: () => void;
  topOffset: number;
}) {
  return (
    <TouchableOpacity
      style={[styles.backBtn, { top: topOffset }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons name="chevron-back" size={24} color="#fff" />
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------
export default function MainScreen() {
  const cameraRef = useRef<CameraView>(null);
  const videoRef = useRef<Video>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [cameraFacing, setCameraFacing] = useState<'front' | 'back'>('back');
  const [prompt, setPrompt] = useState('');
  const [genStatus, setGenStatus] = useState('Starting...');
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState(0);
  const [playbackKey, setPlaybackKey] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
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

  const doneClips = clips.filter((c) => c.status === 'done' && c.videoUri);
  const hasDoneClips = doneClips.length > 0;

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
      setIsPlaying(true);
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

  const togglePlayPause = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      const status = await videoRef.current.getStatusAsync();
      if (status.isLoaded) {
        if (status.isPlaying) {
          await videoRef.current.pauseAsync();
          setIsPlaying(false);
        } else {
          await videoRef.current.playAsync();
          setIsPlaying(true);
        }
      }
    } catch {}
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

  const saveAllClips = useCallback(async () => {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      showModal(
        'Permission Needed',
        'Grant media library access to save videos.',
        [{ text: 'OK', onPress: () => {}, style: 'default' }],
      );
      return;
    }
    for (const clip of doneClips) {
      if (clip.videoUri) {
        await MediaLibrary.saveToLibraryAsync(clip.videoUri);
      }
    }
    showModal(
      'Saved!',
      `${doneClips.length} clip${doneClips.length > 1 ? 's' : ''} saved to gallery.`,
      [{ text: 'Great', onPress: () => {}, style: 'default' }],
    );
  }, [doneClips, showModal]);

  const handlePreviewBack = useCallback(() => {
    showModal(
      'Leave Sequence?',
      'This will discard all clips. Do you want to continue?',
      [
        { text: 'Stay', onPress: () => {}, style: 'cancel' },
        { text: 'Leave', onPress: () => reset(), style: 'destructive' },
      ],
    );
  }, [showModal, reset]);

  const handleDone = useCallback(() => {
    setCurrentPlayingIndex(0);
    setPlaybackKey((k) => k + 1);
    setIsPlaying(true);
    setPhase('finalPlayback');
  }, []);

  // ---- Back / hardware back ----

  const handleBackPress = useCallback((): boolean => {
    if (phase === 'camera') {
      if (hasDoneClips) {
        setPhase('preview');
        return true;
      }
      return false;
    }

    if (phase === 'prompt') {
      if (prompt.trim()) {
        showModal('Discard Changes?', 'You have an unsaved scene description.', [
          { text: 'Stay', onPress: () => {}, style: 'cancel' },
          {
            text: 'Discard',
            onPress: () => {
              setPrompt('');
              setPhase('camera');
            },
            style: 'destructive',
          },
        ]);
      } else {
        setPhase('camera');
      }
      return true;
    }

    if (phase === 'generating') {
      showModal(
        'Cancel Generation?',
        'The video is still being generated. Do you want to cancel?',
        [
          { text: 'Continue', onPress: () => {}, style: 'cancel' },
          {
            text: 'Cancel Generation',
            onPress: cancelGeneration,
            style: 'destructive',
          },
        ],
      );
      return true;
    }

    if (phase === 'preview') {
      handlePreviewBack();
      return true;
    }

    if (phase === 'finalPlayback') {
      setIsPlaying(true);
      setPhase('preview');
      return true;
    }

    return false;
  }, [phase, hasDoneClips, prompt, showModal, cancelGeneration, handlePreviewBack]);

  useEffect(() => {
    const sub = BackHandler.addEventListener(
      'hardwareBackPress',
      handleBackPress,
    );
    return () => sub.remove();
  }, [handleBackPress]);

  // =======================================================================
  // RENDER
  // =======================================================================

  const backBtnTop = insets.top + 10;

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
          {!cameraReady && (
            <View style={styles.cameraLoading}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.cameraLoadingText}>Starting camera...</Text>
            </View>
          )}

          <SafeAreaView style={styles.cameraTopBar}>
            <View style={styles.cameraTopBarInner}>
              {hasDoneClips ? (
                <TouchableOpacity
                  style={styles.cameraTopBtn}
                  onPress={() => handleBackPress()}
                  activeOpacity={0.7}
                >
                  <Ionicons name="chevron-back" size={22} color="#fff" />
                </TouchableOpacity>
              ) : (
                <View style={styles.cameraTopBtnSpacer} />
              )}
              <Text style={styles.cameraTitle}>
                {clips.length === 0
                  ? 'Capture your first scene'
                  : 'Capture next scene'}
              </Text>
              <View style={styles.cameraTopBtnSpacer} />
            </View>
          </SafeAreaView>

          {getLastClip()?.lastFrameUri && (
            <View style={styles.lastFrameFloatingRow}>
              <TouchableOpacity
                style={styles.lastFrameFloatingBtn}
                onPress={useLastFrame}
                activeOpacity={0.7}
              >
                <Text style={styles.lastFrameFloatingBtnText}>
                  Continue from last frame
                </Text>
                <Ionicons
                  name="arrow-forward"
                  size={14}
                  color="#fff"
                  style={{ marginLeft: 6 }}
                />
              </TouchableOpacity>
            </View>
          )}

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
            <TouchableOpacity
              style={styles.flipBtn}
              onPress={toggleCameraFacing}
              activeOpacity={0.7}
            >
              <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
            </TouchableOpacity>
          </View>
        </CameraView>
      </View>
    );
  }

  // ---- Prompt Phase ----
  if (phase === 'prompt') {
    const lastClip = getLastClip();
    const isFirstClip = doneClips.length === 0;
    const usingLastFrame =
      !isFirstClip && selectedImageUri === lastClip?.lastFrameUri;

    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.promptImageSection}>
          {selectedImageUri && (
            <Image
              source={{ uri: selectedImageUri }}
              style={styles.promptImage}
              resizeMode="cover"
            />
          )}

          <BackButton
            onPress={() => handleBackPress()}
            topOffset={backBtnTop}
          />

          {usingLastFrame && (
            <View style={[styles.lastFrameBadge, { top: backBtnTop }]}>
              <Text style={styles.lastFrameBadgeText}>Last frame</Text>
            </View>
          )}

          <View style={styles.imageOptionsOverlay}>
            <TouchableOpacity
              style={styles.imageOptionBtn}
              onPress={() => setPhase('camera')}
              activeOpacity={0.7}
            >
              <Ionicons
                name="camera-outline"
                size={15}
                color="#fff"
                style={{ marginRight: 6 }}
              />
              <Text style={styles.imageOptionBtnText}>
                {usingLastFrame ? 'Camera' : 'Retake'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.imageOptionBtn}
              onPress={pickFromGallery}
              activeOpacity={0.7}
            >
              <Ionicons
                name="images-outline"
                size={15}
                color="#fff"
                style={{ marginRight: 6 }}
              />
              <Text style={styles.imageOptionBtnText}>Gallery</Text>
            </TouchableOpacity>
            {!isFirstClip && !usingLastFrame && lastClip?.lastFrameUri && (
              <TouchableOpacity
                style={styles.imageOptionBtnHighlight}
                onPress={useLastFrame}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="play-forward-outline"
                  size={15}
                  color="#fff"
                  style={{ marginRight: 6 }}
                />
                <Text style={styles.imageOptionBtnHighlightText}>
                  Last Frame
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={styles.promptBottomSection}>
          <Text style={styles.promptTitle}>
            {isFirstClip
              ? 'Describe the scene'
              : `Clip ${doneClips.length + 1}`}
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
            textAlignVertical="top"
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
        {selectedImageUri && (
          <Image
            source={{ uri: selectedImageUri }}
            style={styles.fullScreenMedia}
            resizeMode="cover"
          />
        )}

        <View style={styles.genOverlay}>
          <BackButton
            onPress={() => handleBackPress()}
            topOffset={backBtnTop}
          />

          <View style={styles.genCenter}>
            <Text style={styles.genStatusText}>{genStatus}</Text>
            <ProgressBar />
            <Text style={styles.genHintText}>
              Usually takes 30–90 seconds
            </Text>
          </View>

          <SafeAreaView style={styles.genBottom}>
            <TouchableOpacity
              style={styles.genCancelBtn}
              onPress={() => handleBackPress()}
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

  // ---- Final Playback Phase ----
  if (phase === 'finalPlayback') {
    const currentClip = doneClips[currentPlayingIndex];

    return (
      <View style={styles.container}>
        {/* Video fills most of the screen */}
        <SafeAreaView style={styles.fpContainer}>
          {/* Top bar */}
          <View style={styles.fpTopBar}>
            <TouchableOpacity
              style={styles.pvTopBtn}
              onPress={() => {
                setIsPlaying(true);
                setPhase('preview');
              }}
              activeOpacity={0.7}
            >
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.fpTitle}>Final Preview</Text>
            <TouchableOpacity
              style={styles.pvTopBtn}
              onPress={saveAllClips}
              activeOpacity={0.7}
            >
              <Ionicons name="arrow-down" size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Video player */}
          <View style={styles.fpVideoContainer}>
            {currentClip?.videoUri && (
              <TouchableOpacity
                activeOpacity={1}
                onPress={togglePlayPause}
                style={styles.fpVideoTouchable}
              >
                <Video
                  key={`fp-${currentClip.id}-${playbackKey}`}
                  ref={videoRef}
                  source={{ uri: currentClip.videoUri }}
                  style={styles.fpVideo}
                  resizeMode={'contain' as any}
                  shouldPlay
                  onPlaybackStatusUpdate={(status) => {
                    if (status.isLoaded) {
                      if (status.didJustFinish) {
                        const nextIdx = currentPlayingIndex + 1;
                        if (nextIdx >= doneClips.length) {
                          setCurrentPlayingIndex(0);
                        } else {
                          setCurrentPlayingIndex(nextIdx);
                        }
                        setPlaybackKey((k) => k + 1);
                      }
                      setIsPlaying(status.isPlaying);
                    }
                  }}
                />
                {!isPlaying && (
                  <View style={styles.fpPauseOverlay}>
                    <Ionicons name="play" size={56} color="rgba(255,255,255,0.8)" />
                  </View>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* Progress */}
          <View style={styles.fpBottom}>
            <Text style={styles.fpProgressText}>
              Playing clip {currentPlayingIndex + 1} of {doneClips.length}
            </Text>
            {/* Dot indicators */}
            <View style={styles.fpDots}>
              {doneClips.map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.fpDot,
                    i === currentPlayingIndex && styles.fpDotActive,
                  ]}
                />
              ))}
            </View>
          </View>
        </SafeAreaView>

        <CustomModal modal={modal} onClose={hideModal} />
      </View>
    );
  }

  // ---- Preview Phase ----
  const currentClip = doneClips[currentPlayingIndex];

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.pvContainer}>
        {/* Top bar: back | counter | done */}
        <View style={styles.pvTopBar}>
          <TouchableOpacity
            style={styles.pvTopBtn}
            onPress={handlePreviewBack}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </TouchableOpacity>

          <Text style={styles.pvCounterText}>
            Clip {currentPlayingIndex + 1} of {doneClips.length}
          </Text>

          <TouchableOpacity
            style={styles.pvDoneBtn}
            onPress={handleDone}
            activeOpacity={0.7}
          >
            <Ionicons name="checkmark" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Video player */}
        <View style={styles.pvVideoContainer}>
          {currentClip?.videoUri && (
            <TouchableOpacity
              activeOpacity={1}
              onPress={togglePlayPause}
              style={styles.pvVideoTouchable}
            >
              <Video
                key={`pv-${currentClip.id}-${playbackKey}`}
                ref={videoRef}
                source={{ uri: currentClip.videoUri }}
                style={styles.pvVideo}
                resizeMode={'contain' as any}
                shouldPlay
                isLooping
                onPlaybackStatusUpdate={(status) => {
                  if (status.isLoaded) {
                    setIsPlaying(status.isPlaying);
                  }
                }}
              />
              {!isPlaying && (
                <View style={styles.pvPauseOverlay}>
                  <Ionicons name="play" size={48} color="rgba(255,255,255,0.8)" />
                </View>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Thumbnail strip */}
        {doneClips.length > 1 && (
          <ScrollView
            horizontal
            style={styles.pvThumbnailStrip}
            contentContainerStyle={styles.pvThumbnailStripContent}
            showsHorizontalScrollIndicator={false}
          >
            {doneClips.map((clip, idx) => (
              <TouchableOpacity
                key={clip.id}
                onPress={() => {
                  setCurrentPlayingIndex(idx);
                  setIsPlaying(true);
                  setPlaybackKey((k) => k + 1);
                }}
                style={[
                  styles.pvThumb,
                  idx === currentPlayingIndex && styles.pvThumbActive,
                ]}
              >
                <Image
                  source={{ uri: clip.imageUri }}
                  style={styles.pvThumbImage}
                />
                <Text style={styles.pvThumbLabel}>{idx + 1}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Action buttons: retry | append | save */}
        <View style={styles.pvActionRow}>
          <TouchableOpacity
            style={styles.pvActionBtn}
            onPress={handleRetry}
            activeOpacity={0.7}
          >
            <Ionicons name="refresh" size={22} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.pvActionBtn,
              styles.pvActionBtnAccent,
              doneClips.length >= MAX_CLIPS && styles.pvActionBtnDisabled,
            ]}
            onPress={handleAddNextClip}
            disabled={doneClips.length >= MAX_CLIPS}
            activeOpacity={0.7}
          >
            <Ionicons name="add" size={26} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.pvActionBtn}
            onPress={() =>
              currentClip?.videoUri &&
              saveClipToGallery(currentClip.videoUri)
            }
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-down" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <CustomModal modal={modal} onClose={hideModal} />
    </View>
  );
}

// ==========================================================================
// Styles
// ==========================================================================

const styles = StyleSheet.create({
  // -- Shared --
  container: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  backBtn: {
    position: 'absolute',
    left: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },

  // -- Permission --
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
  camera: { flex: 1 },
  cameraLoading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 10,
  },
  cameraLoadingText: { color: '#fff', fontSize: 14, marginTop: 12 },
  cameraTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
  },
  cameraTopBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    height: 48,
  },
  cameraTopBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  cameraTopBtnSpacer: { width: 40 },
  cameraTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  lastFrameFloatingRow: {
    position: 'absolute',
    bottom: 130,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  lastFrameFloatingBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(100,50,255,0.6)',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(100,50,255,0.8)',
  },
  lastFrameFloatingBtnText: {
    color: '#fff',
    fontSize: 14,
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
    paddingHorizontal: 24,
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
    minWidth: 64,
    alignItems: 'center',
  },
  galleryBtnText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  flipBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // -- Prompt --
  promptImageSection: { flex: 1, backgroundColor: '#111' },
  promptImage: { width: '100%', height: '100%' },
  lastFrameBadge: {
    position: 'absolute',
    right: 16,
    backgroundColor: 'rgba(100,50,255,0.85)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
  },
  lastFrameBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  imageOptionsOverlay: {
    position: 'absolute',
    bottom: 30,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  imageOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(20,20,20,0.7)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  imageOptionBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  imageOptionBtnHighlight: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(100,50,255,0.55)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(100,50,255,0.8)',
    shadowColor: '#6432ff',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  imageOptionBtnHighlightText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  promptBottomSection: {
    backgroundColor: '#0a0a0a',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 18,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
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
    backgroundColor: '#151515',
    color: '#fff',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    fontSize: 15,
    minHeight: 90,
    maxHeight: 130,
    textAlignVertical: 'top',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    lineHeight: 22,
  },
  generateBtn: {
    backgroundColor: '#6432ff',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  generateBtnDisabled: { opacity: 0.35 },
  generateBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

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
  genStatusText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  genHintText: { color: 'rgba(255,255,255,0.45)', fontSize: 13 },
  genBottom: { alignItems: 'center', paddingBottom: 24 },
  genCancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 44,
    paddingVertical: 14,
    borderRadius: 26,
  },
  genCancelBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // -- Preview --
  pvContainer: { flex: 1, backgroundColor: '#000' },
  pvTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pvTopBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#1c1c1e',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  pvDoneBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#6432ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pvCounterText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '600',
  },
  pvVideoContainer: {
    flex: 1,
    marginHorizontal: 12,
    marginTop: 4,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  pvVideoTouchable: { flex: 1 },
  pvVideo: { width: '100%', height: '100%' },
  pvPauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  pvThumbnailStrip: {
    marginTop: 12,
    maxHeight: 52,
    flexGrow: 0,
  },
  pvThumbnailStripContent: {
    gap: 6,
    paddingHorizontal: 16,
  },
  pvThumb: {
    width: 46,
    height: 46,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  pvThumbActive: { borderColor: '#6432ff' },
  pvThumbImage: { width: '100%', height: '100%' },
  pvThumbLabel: {
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
  pvActionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    paddingBottom: 16,
  },
  pvActionBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1c1c1e',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  pvActionBtnAccent: {
    backgroundColor: '#6432ff',
    borderColor: '#6432ff',
  },
  pvActionBtnDisabled: { opacity: 0.3 },

  // -- Final Playback --
  fpContainer: { flex: 1, backgroundColor: '#000' },
  fpTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  fpTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  fpVideoContainer: {
    flex: 1,
    marginHorizontal: 8,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  fpVideoTouchable: { flex: 1 },
  fpVideo: { width: '100%', height: '100%' },
  fpPauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  fpBottom: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 10,
  },
  fpProgressText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '500',
  },
  fpDots: {
    flexDirection: 'row',
    gap: 6,
  },
  fpDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  fpDotActive: {
    backgroundColor: '#6432ff',
  },
});
