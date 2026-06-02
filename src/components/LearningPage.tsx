"use client";
import { useState, useEffect, useRef } from "react";
import AIChatbot from "./AIChatbot";
import { HoverBorderGradient } from "@/ui/hover-border-gradient";
import { AnimatedShinyText } from "@/ui/animated-shiny-text";
import { cn } from "@/lib/utils";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { ref, getDownloadURL, listAll } from "firebase/storage";
import { doc, setDoc, getDoc, collection, onSnapshot, query, where, deleteDoc, addDoc, updateDoc, increment } from "firebase/firestore";
import { storage, db } from "./firebaseConfig";
import { authFetch } from "../lib/api";
import { FiChevronDown, FiX, FiSave, FiEdit3, FiTrash2 } from "react-icons/fi";
import { FloatingDock } from "@/ui/floating-dock";
import { Phone, BookOpen, Sparkles } from "lucide-react";

// MURF_API_KEY consolidated to backend

const getCurrentUserId = () => {
  return localStorage.getItem("userId") || "defaultUser";
};

const slideVariants: Variants = {
  hidden: (direction: number) => ({
    x: direction > 0 ? 300 : -300,
    opacity: 0,
  }),
  visible: {
    x: 0,
    opacity: 1,
    transition: { type: "spring", stiffness: 300, damping: 30 },
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -300 : 300,
    opacity: 0,
    transition: { duration: 0.2 },
  }),
};

// Language options
const LANGUAGE_OPTIONS = [
  { code: "en-US", label: "English", voiceId: "en-US-natalie" },
  { code: "hi-IN", label: "Hindi - India", voiceId: "hi-IN-ayushi" },
  { code: "ta-IN", label: "Tamil - India", voiceId: "ta-IN-abirami" },
  { code: "bn-IN", label: "Bengali - India", voiceId: "bn-IN-ishani" },
];

interface Note {
  id: string;
  title: string;
  content: string;
  timestamp: Date;
  lessonTitle: string;
}

interface SceneData {
  title: string;
  scene_number?: number;
  narration?: string;
  animation_description?: string;
  image_url?: string;
  assessment: {
    multiple_choice: {
      question: string;
      choices: string[];
      correct_index: number;
    };
    free_response?: {
      question: string;
      answer: string;
    };
  };
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

const LearningPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [videoURLs, setVideoURLs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [boredomScore, setBoredomScore] = useState(0);
  const [showBoredomOverlay, setShowBoredomOverlay] = useState(false);
  const [isUpdatingPacing, setIsUpdatingPacing] = useState(false);

  // Async job rendering state variables
  const [jobId, setJobId] = useState<string | null>(location.state?.jobId || null);
  const [jobProgress, setJobProgress] = useState<number>(0);
  const [jobMessage, setJobMessage] = useState<string>("Initializing...");
  const [lessonsData, setLessonsData] = useState<SceneData[]>(location.state?.responseData || []);
  const [jobError, setJobError] = useState<string | null>(null);
  const [audioProvider, setAudioProvider] = useState<"elevenlabs" | "murf">("elevenlabs");
  const [worldState, setWorldState] = useState<any>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);

  // Gamification states
  const [totalXP, setTotalXP] = useState<number>(0);
  const [userLevel, setUserLevel] = useState<number>(1);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [userRank, setUserRank] = useState<number>(0);
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState<boolean>(true);

  const fetchLeaderboardAndXP = async () => {
    try {
      const response = await authFetch(`${BACKEND_URL}/api/leaderboard`);
      if (response.ok) {
        const data = await response.json();
        setLeaderboard(data.leaderboard || []);
        setUserRank(data.user_rank || 0);
        const xp = data.user_score || 0;
        setTotalXP(xp);
        setUserLevel(Math.floor(xp / 100) + 1);
      }
    } catch (err) {
      console.error("Error loading leaderboard and XP:", err);
    }
  };

  // Multiplayer & Co-op States
  const [onlinePeers, setOnlinePeers] = useState<string[]>([]);
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [currentLobbyId, setCurrentLobbyId] = useState<string | null>(null);
  const [lobbyState, setLobbyState] = useState<any>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [typedMessage, setTypedMessage] = useState<string>("");
  const [isLobbyPanelOpen, setIsLobbyPanelOpen] = useState<boolean>(true);
  const [newLobbyName, setNewLobbyName] = useState<string>("");

  // Multiplayer Actions
  const createLobby = async () => {
    if (!newLobbyName.trim()) return;
    const userId = getCurrentUserId();
    try {
      const docRef = await addDoc(collection(db, "lobbies"), {
        name: newLobbyName,
        members: [userId],
        bossName: "Math Kraken",
        bossMaxHp: 100,
        bossHp: 100,
        status: "active",
        createdAt: Date.now()
      });
      setCurrentLobbyId(docRef.id);
      setNewLobbyName("");
    } catch (err) {
      console.error("Error creating lobby:", err);
    }
  };

  const joinLobby = async (lobbyId: string) => {
    const userId = getCurrentUserId();
    const lobbyRef = doc(db, "lobbies", lobbyId);
    try {
      const docSnap = await getDoc(lobbyRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (!data.members.includes(userId)) {
          await updateDoc(lobbyRef, {
            members: [...data.members, userId]
          });
        }
        setCurrentLobbyId(lobbyId);
      }
    } catch (err) {
      console.error("Error joining lobby:", err);
    }
  };

  const leaveLobby = async () => {
    if (!currentLobbyId) return;
    const userId = getCurrentUserId();
    const lobbyRef = doc(db, "lobbies", currentLobbyId);
    try {
      const docSnap = await getDoc(lobbyRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        const updatedMembers = data.members.filter((uid: string) => uid !== userId);
        if (updatedMembers.length === 0) {
          await deleteDoc(lobbyRef);
        } else {
          await updateDoc(lobbyRef, {
            members: updatedMembers
          });
        }
      }
      setCurrentLobbyId(null);
      setLobbyState(null);
      setChatMessages([]);
    } catch (err) {
      console.error("Error leaving lobby:", err);
    }
  };

  const sendChatMessage = async () => {
    if (!typedMessage.trim() || !currentLobbyId) return;
    const userId = getCurrentUserId();
    const textToSend = typedMessage;
    setTypedMessage("");
    try {
      const response = await authFetch(`${BACKEND_URL}/api/multiplayer/moderate-chat`, {
        method: "POST",
        body: JSON.stringify({ message: textToSend })
      });
      if (response.ok) {
        const data = await response.json();
        await addDoc(collection(db, "lobby_messages"), {
          lobbyId: currentLobbyId,
          senderId: userId,
          text: data.sanitized,
          timestamp: Date.now()
        });
      }
    } catch (err) {
      console.error("Error sending chat message:", err);
    }
  };

  const handleBossDefeat = async (lobbyData: any) => {
    if (lobbyData.status !== "active") return;
    const lobbyRef = doc(db, "lobbies", lobbyData.id);
    try {
      await updateDoc(lobbyRef, { status: "defeated" });
      const response = await authFetch(`${BACKEND_URL}/api/multiplayer/boss-rewards`, {
        method: "POST",
        body: JSON.stringify({ user_ids: lobbyData.members })
      });
      if (response.ok) {
        alert("🎉 Cooperative Boss Defeated! Every member of the lobby was awarded +100 XP!");
        fetchLeaderboardAndXP();
      }
    } catch (err) {
      console.error("Error handling boss defeat rewards:", err);
    }
  };

  // Presence and general Firestore subscriptions
  useEffect(() => {
    const userId = getCurrentUserId();
    const presenceRef = doc(db, "presence", userId);

    const markOnline = async () => {
      try {
        await setDoc(presenceRef, { userId, online: true, lastActive: Date.now() }, { merge: true });
      } catch (err) {
        console.error("Error setting presence:", err);
      }
    };
    markOnline();

    const presenceQuery = query(collection(db, "presence"));
    const unsubPresence = onSnapshot(presenceQuery, (snapshot) => {
      const peers: string[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.userId && data.userId !== userId && data.online) {
          peers.push(data.userId);
        }
      });
      setOnlinePeers(peers);
    });

    const lobbiesQuery = query(collection(db, "lobbies"));
    const unsubLobbies = onSnapshot(lobbiesQuery, (snapshot) => {
      const activeLobbies: any[] = [];
      snapshot.forEach((docSnap) => {
        activeLobbies.push({ id: docSnap.id, ...docSnap.data() });
      });
      setLobbies(activeLobbies);
    });

    const handleCleanup = async () => {
      try {
        await deleteDoc(presenceRef);
      } catch (err) {
        console.error("Error clearing presence:", err);
      }
    };

    window.addEventListener("beforeunload", handleCleanup);

    return () => {
      handleCleanup();
      unsubPresence();
      unsubLobbies();
      window.removeEventListener("beforeunload", handleCleanup);
    };
  }, []);

  // Active Lobby Sync
  useEffect(() => {
    if (!currentLobbyId) return;

    const lobbyRef = doc(db, "lobbies", currentLobbyId);
    const unsubLobbyDoc = onSnapshot(lobbyRef, (docSnap) => {
      if (docSnap.exists()) {
        const data: any = { id: docSnap.id, ...docSnap.data() };
        setLobbyState(data);
        if (data.bossHp <= 0 && data.status === "active") {
          handleBossDefeat(data);
        }
      }
    });

    const chatQuery = query(
      collection(db, "lobby_messages"),
      where("lobbyId", "==", currentLobbyId)
    );
    const unsubChat = onSnapshot(chatQuery, (snapshot) => {
      const msgs: any[] = [];
      snapshot.forEach((docSnap) => {
        msgs.push({ id: docSnap.id, ...docSnap.data() });
      });
      msgs.sort((a, b) => a.timestamp - b.timestamp);
      setChatMessages(msgs);
    });

    return () => {
      unsubLobbyDoc();
      unsubChat();
    };
  }, [currentLobbyId]);

  // Log boredom score when it changes to satisfy TS unused check
  useEffect(() => {
    console.log("Active boredom score updated:", boredomScore);
  }, [boredomScore]);

  // Use actual generated lesson data — no hardcoded fallback so the wrong topic never shows
  const FetchData = lessonsData;

  useEffect(() => {
    console.log("[DIAGNOSTIC] LearningPage slides loaded:", FetchData);
  }, [FetchData]);

  const [selectedAnswerIndex, setSelectedAnswerIndex] = useState<number | null>(
    null
  );
  const [hasAnswered, setHasAnswered] = useState(false);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [maxReachedSlideIndex, setMaxReachedSlideIndex] = useState(0);

  //Narration Logic
  const [narrationWords, setNarrationWords] = useState<string[]>([]);
  const [currentWordIndex, setCurrentWordIndex] = useState<number>(-1);

  // Safe current slide — empty placeholder if data hasn't loaded yet
  const EMPTY_SLIDE: SceneData = {
    title: "Loading...",
    assessment: { multiple_choice: { question: "", choices: [], correct_index: 0 } },
  };
  const currentSlide = FetchData[currentSlideIndex] ?? FetchData[0] ?? EMPTY_SLIDE;
  const answer = currentSlide.assessment.multiple_choice.choices;
  const question = currentSlide.assessment.multiple_choice.question;
  const correctAnswerIndex = currentSlide.assessment.multiple_choice.correct_index;
  const isSlideCompleted = currentSlideIndex < maxReachedSlideIndex || hasAnswered;
  const mediaUrl = currentSlide?.image_url || videoURLs[currentSlideIndex] || videoURLs[currentVideoIndex] || "";
  console.log(`[VISUAL DEBUG] Slide ${currentSlideIndex}: image_url=${currentSlide?.image_url ? 'YES (' + currentSlide.image_url.substring(0, 50) + '...)' : 'NONE'}, mediaUrl=${mediaUrl ? 'YES' : 'EMPTY'}, keys=${currentSlide ? Object.keys(currentSlide).join(',') : 'null'}`);
  const isVideo = typeof mediaUrl === "string" && (
    mediaUrl.toLowerCase().endsWith(".mp4") || 
    mediaUrl.toLowerCase().endsWith(".webm") || 
    mediaUrl.includes("firebasestorage.googleapis.com") || 
    mediaUrl.includes("placeholder.mp4")
  );

  const lessonsDataRef = useRef<SceneData[]>(lessonsData);
  lessonsDataRef.current = lessonsData;

  const murfAudioRef = useRef<HTMLAudioElement | null>(null);
  const [showCallModal, setShowCallModal] = useState(false);
  const [isCallLoading, setIsCallLoading] = useState(false);

  // Language-related states
  const [selectedLanguage, setSelectedLanguage] = useState(LANGUAGE_OPTIONS[0]);
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);
  const [translatedNarration, setTranslatedNarration] = useState<string>("");
  const [isTranslating, setIsTranslating] = useState(false);

  // Notes state
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentNote, setCurrentNote] = useState({ title: "", content: "" });
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);

  // WebSocket setup for async generation
  useEffect(() => {
    // Reset state when a new lesson starts
    setCurrentSlideIndex(0);
    setCurrentVideoIndex(0);
    setMaxReachedSlideIndex(0);
    setJobProgress(0);
    setJobMessage("Initializing generation request...");
    setJobError(null);

    if (!jobId) {
      // Fallback: fetch all videos from Firebase Storage if no jobId exists (static/mock mode)
      const fetchVideos = async () => {
        try {
          setLoading(true);
          const storageRef = ref(storage, "/");
          const result = await listAll(storageRef);
          const videoRefs = result.items.filter((item) =>
            item.name.toLowerCase().endsWith(".mp4")
          );
          videoRefs.sort((a, b) => {
            const sceneA = a.name.match(/_Scene(\d+)\.mp4$/i);
            const sceneB = b.name.match(/_Scene(\d+)\.mp4$/i);
            if (sceneA && sceneB) {
              return Number.parseInt(sceneA[1]) - Number.parseInt(sceneB[1]);
            }
            return a.name.localeCompare(b.name);
          });
          const urls = await Promise.all(
            videoRefs.map((videoRef) => getDownloadURL(videoRef))
          );
          setVideoURLs(urls);
          setLoading(false);
        } catch (error) {
          console.error("Error fetching static videos:", error);
          setLoading(false);
        }
      };
      
      if (lessonsDataRef.current.length === 0) {
        fetchVideos();
      } else {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    
    // Resolve ws/wss protocol relative to BACKEND_URL
    let wsUrl = "";
    try {
      const url = new URL(BACKEND_URL);
      const protocol = url.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = `${protocol}//${url.host}/ws/generation/${jobId}`;
    } catch (e) {
      wsUrl = `ws://localhost:3001/ws/generation/${jobId}`;
    }
    
    console.log(`Connecting to generation WebSocket: ${wsUrl}`);
    const socket = new WebSocket(wsUrl);

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        console.log("WebSocket event received:", payload);
        
        if (payload.progress !== undefined) {
          setJobProgress(payload.progress);
        }
        if (payload.message) {
          setJobMessage(payload.message);
        }

        if (payload.status === "completed" || payload.status === "lesson_ready") {
          socket.close();
          const scenes = payload.data?.scenes || [];
          setLessonsData(scenes);
          setLoading(false);
        } else if (payload.status === "failed") {
          socket.close();
          setJobError(payload.error || "An unexpected error occurred during rendering.");
          setLoading(false);
        }
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket error details:", error);
    };

    socket.onclose = (event) => {
      console.log(`WebSocket connection closed (code: ${event.code}, reason: ${event.reason})`);
      // Fallback in case of unexpected close before completion
      if (event.code !== 1000 && event.code !== 1001) {
        console.warn("WebSocket closed unexpectedly. Attempting status fetch...");
        authFetch(`${BACKEND_URL}/api/job-status/${jobId}`)
          .then(res => res.json())
          .then(job => {
            if (job.status === "completed") {
              setLessonsData(job.data?.scenes || []);
              setLoading(false);
            } else if (job.status === "failed") {
              setJobError(job.error || "An unexpected error occurred.");
              setLoading(false);
            }
          }).catch(e => console.error("Job status fallback fetch error:", e));
      }
    };

    return () => {
      socket.close();
    };
  }, [jobId]);

  const loadWorldState = async () => {
    try {
      const response = await authFetch(`${BACKEND_URL}/api/world/state`);
      if (response.ok) {
        const data = await response.json();
        if (data.exists) {
          setWorldState(data.world);
        }
      }
    } catch (err) {
      console.error("Error loading world state:", err);
    }
  };

  // Load notes and world state when component mounts
  useEffect(() => {
    loadNotes();
    loadWorldState();
    fetchLeaderboardAndXP();
  }, []);

  // Add this useEffect after the existing useEffects, around line 120
  useEffect(() => {
    const handleBeforeUnload = () => {
      localStorage.removeItem("userId");
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Boredom checker effect
  useEffect(() => {
    if (loading || showBoredomOverlay) return;

    const checkBoredom = async () => {
      try {
        const response = await authFetch(`${BACKEND_URL}/api/boredom-check`);
        if (response.ok) {
          const data = await response.json();
          setBoredomScore(data.boredom_score);
          if (data.requires_intervention) {
            setShowBoredomOverlay(true);
            authFetch(`${BACKEND_URL}/api/milestones`, {
              method: "POST",
              body: JSON.stringify({
                milestone_type: "failed_concept",
                concept_id: currentSlide.title,
                description: `Boredom threshold exceeded: ${data.boredom_score}`,
                associated_sentiment: -0.5
              })
            }).catch(e => console.error("Milestone tracking error:", e));
          }
        }
      } catch (err) {
        console.error("Error running boredom check:", err);
      }
    };

    const interval = setInterval(checkBoredom, 10000);
    return () => clearInterval(interval);
  }, [loading, showBoredomOverlay, currentSlide]);



  async function handleAnswerClick(currIndex: number) {
    setSelectedAnswerIndex(currIndex);
    setHasAnswered(true);

    const isCorrect = currIndex === correctAnswerIndex;

    try {
      // Award XP delta: +15 XP for correct answer, +0 XP for incorrect answer
      const xpPromise = authFetch(`${BACKEND_URL}/api/profile/xp`, {
        method: "POST",
        body: JSON.stringify({
          xp_delta: isCorrect ? 15 : 0,
          source_type: isCorrect ? "quiz_correct" : "quiz_incorrect"
        })
      });

      const milestonePromise = authFetch(`${BACKEND_URL}/api/milestones`, {
        method: "POST",
        body: JSON.stringify({
          milestone_type: isCorrect ? "biggest_win" : "failed_concept",
          concept_id: currentSlide.title,
          description: isCorrect
            ? "Correct answer on assessment"
            : "Incorrect answer on assessment",
          associated_sentiment: isCorrect ? 0.8 : -0.3,
          mastery_delta: isCorrect ? 0.2 : -0.1,
        }),
      });

      const companionPromise = authFetch(`${BACKEND_URL}/api/world/companion`, {
        method: "POST",
        body: JSON.stringify({
          relationship_delta: isCorrect ? 2 : -1,
        }),
      });

      const [xpRes] = await Promise.all([xpPromise, milestonePromise, companionPromise]);
      
      if (xpRes && xpRes.ok) {
        const xpData = await xpRes.json();
        if (xpData.total_xp !== undefined) {
          setTotalXP(xpData.total_xp);
          setUserLevel(xpData.level || Math.floor(xpData.total_xp / 100) + 1);
        }
      }

      // If user is in a lobby and answers correctly, damage boss HP in Firestore
      if (isCorrect && currentLobbyId) {
        try {
          const lobbyRef = doc(db, "lobbies", currentLobbyId);
          await updateDoc(lobbyRef, {
            bossHp: increment(-10)
          });
        } catch (lobbyHpErr) {
          console.error("Error updating boss HP:", lobbyHpErr);
        }
      }

      // If correct (milestone / biggest win), award milestone completion +50 XP
      if (isCorrect) {
        try {
          const milestoneXpRes = await authFetch(`${BACKEND_URL}/api/profile/xp`, {
            method: "POST",
            body: JSON.stringify({
              xp_delta: 50,
              source_type: "milestone_completion"
            })
          });
          if (milestoneXpRes && milestoneXpRes.ok) {
            const mXpData = await milestoneXpRes.json();
            if (mXpData.total_xp !== undefined) {
              setTotalXP(mXpData.total_xp);
              setUserLevel(mXpData.level || Math.floor(mXpData.total_xp / 100) + 1);
            }
          }
        } catch (mXpErr) {
          console.error("Error awarding milestone completion XP:", mXpErr);
        }
      }

      loadWorldState();
      fetchLeaderboardAndXP();
      console.log("Recorded answer outcome, updated companion status, and added XP.");
    } catch (err) {
      console.error("Error updating milestone/companion stats and XP:", err);
    }
  }

  function handleNextSlide() {
    const totalSlides = Math.min(FetchData.length || videoURLs.length || 5, 5);
    if (currentSlideIndex < totalSlides - 1) {
      const nextIndex = currentSlideIndex + 1;
      setCurrentSlideIndex(nextIndex);
      setMaxReachedSlideIndex((prev) => Math.max(prev, nextIndex));
      if (videoURLs.length > 0) {
        setCurrentVideoIndex(Math.min(nextIndex, videoURLs.length - 1));
      }
    } else {
      setCurrentSlideIndex(0);
      if (videoURLs.length > 0) {
        setCurrentVideoIndex(0);
      }
    }
    setSelectedAnswerIndex(null);
    setHasAnswered(false);
  }

  function handlePrevSlide() {
    if (currentSlideIndex > 0) {
      const prevIndex = currentSlideIndex - 1;
      setCurrentSlideIndex(prevIndex);
      if (videoURLs.length > 0) {
        setCurrentVideoIndex(prevIndex);
      }
      setSelectedAnswerIndex(null);
      setHasAnswered(false);
    }
  }

  const [direction, setDirection] = useState(1);

  function animatedNextSlide() {
    setDirection(1);
    handleNextSlide();
  }

  // Notes functions
  const loadNotes = async () => {
    try {
      setNotesLoading(true);
      const userId = getCurrentUserId();
      const notesDoc = await getDoc(doc(db, "userNotes", userId));

      if (notesDoc.exists()) {
        const userData = notesDoc.data();
        const userNotes = userData.notes || [];
        // Convert timestamps back to Date objects
        const formattedNotes = userNotes.map((note: { id: string; title: string; content: string; timestamp: { toDate?: () => Date } | string | Date; lessonTitle: string }) => ({
          ...note,
          timestamp: note.timestamp && typeof note.timestamp === "object" && "toDate" in note.timestamp && typeof note.timestamp.toDate === "function"
            ? note.timestamp.toDate()
            : new Date(note.timestamp as string | Date),
        }));
        setNotes(formattedNotes);
      }
    } catch (error) {
      console.error("Error loading notes:", error);
    } finally {
      setNotesLoading(false);
    }
  };

  const saveNote = async () => {
    if (!currentNote.title.trim() || !currentNote.content.trim()) return;

    try {
      setIsSavingNote(true);
      const userId = getCurrentUserId();
      const noteId = editingNoteId || Date.now().toString();

      const noteData = {
        id: noteId,
        title: currentNote.title,
        content: currentNote.content,
        timestamp: new Date(),
        lessonTitle: currentSlide.title,
      };

      if (isEditingNote && editingNoteId) {
        // Update existing note
        const updatedNotes = notes.map((note) =>
          note.id === editingNoteId ? noteData : note
        );
        await setDoc(doc(db, "userNotes", userId), { notes: updatedNotes });
        setNotes(updatedNotes);
      } else {
        // Add new note
        const newNotes = [...notes, noteData];
        await setDoc(doc(db, "userNotes", userId), { notes: newNotes });
        setNotes(newNotes);
      }

      // Reset form
      setCurrentNote({ title: "", content: "" });
      setIsEditingNote(false);
      setEditingNoteId(null);
    } catch (error) {
      console.error("Error saving note:", error);
    } finally {
      setIsSavingNote(false);
    }
  };

  const editNote = (note: Note) => {
    setCurrentNote({ title: note.title, content: note.content });
    setIsEditingNote(true);
    setEditingNoteId(note.id);
  };

  const deleteNote = async (noteId: string) => {
    try {
      const userId = getCurrentUserId();
      const updatedNotes = notes.filter((note) => note.id !== noteId);
      await setDoc(doc(db, "userNotes", userId), { notes: updatedNotes });
      setNotes(updatedNotes);
    } catch (error) {
      console.error("Error deleting note:", error);
    }
  };

  const resetNoteForm = () => {
    setCurrentNote({ title: "", content: "" });
    setIsEditingNote(false);
    setEditingNoteId(null);
  };

  // Function to stop all audio playback
  const stopAllAudio = () => {
    if (murfAudioRef.current) {
      murfAudioRef.current.pause();
      murfAudioRef.current.currentTime = 0;
      murfAudioRef.current.removeEventListener("timeupdate", () => {});
      murfAudioRef.current = null;
    }
    window.speechSynthesis.cancel();
    setIsAudioPlaying(false);
    setCurrentWordIndex(-1);
  };

  // Translation function
  const translateText = async (
    text: string,
    targetLanguage: string
  ): Promise<string> => {
    if (targetLanguage === "en-US") {
      return text; // Return original text for English
    }

    try {
      setIsTranslating(true);
      const response = await authFetch(
        `${BACKEND_URL}/api/translate`,
        {
          method: "POST",
          body: JSON.stringify({
            targetLanguage: targetLanguage,
            texts: [text],
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.translations && data.translations.length > 0) {
        return data.translations[0].translated_text;
      }
      return text; // Fallback to original text
    } catch (error) {
      console.error("Translation failed:", error);
      return text; // Fallback to original text
    } finally {
      setIsTranslating(false);
    }
  };

  // Handle language change
  const handleLanguageChange = async (
    language: (typeof LANGUAGE_OPTIONS)[0]
  ) => {
    // Stop all current audio first
    stopAllAudio();

    setSelectedLanguage(language);
    setShowLanguageDropdown(false);

    // Translate the narration
    const translated = await translateText(
      currentSlide.narration || "",
      language.code
    );
    setTranslatedNarration(translated);
  };

  //It Shows Paragraph Immediately
  useEffect(() => {
    const textToUse = translatedNarration || currentSlide.narration;
    if (textToUse) {
      const words = textToUse.trim().split(/\s+/);
      setNarrationWords(words);
      setCurrentWordIndex(-1); // Reset on new slide
    }
  }, [currentSlide.narration, translatedNarration]);

  // Reset translation when slide changes
  useEffect(() => {
    stopAllAudio(); // Stop audio when slide changes
    setTranslatedNarration("");
    setSelectedLanguage(LANGUAGE_OPTIONS[0]); // Reset to English
  }, [currentSlideIndex]);

  useEffect(() => {
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let timeUpdateHandler: ((event: Event) => void) | null = null;

    async function fetchAndPlayAudio() {
      // Stop any existing audio before starting new one
      stopAllAudio();

      const textToNarrate = translatedNarration || currentSlide.narration;
      if (!textToNarrate) return;

      // Tier 1: ElevenLabs High-Fidelity Spark Voice
      if (audioProvider === "elevenlabs") {
        try {
          console.log("Playing narration with ElevenLabs...");
          const firstRegion = worldState?.unlocked_regions?.[0] || "";
          let companionType = "Spark Owl";
          if (firstRegion.toLowerCase().includes("numbers") || firstRegion.toLowerCase().includes("valley")) {
            companionType = "Spark Owl";
          } else if (firstRegion.toLowerCase().includes("spire") || firstRegion.toLowerCase().includes("starry")) {
            companionType = "Ember Dragon";
          } else if (firstRegion.toLowerCase().includes("reef") || firstRegion.toLowerCase().includes("chromatic")) {
            companionType = "Aqua Mermaid";
          }

          const response = await authFetch(
            `${BACKEND_URL}/api/narrate-elevenlabs`,
            {
              method: "POST",
              body: JSON.stringify({
                text: textToNarrate,
                companionType: companionType,
              }),
            }
          );

          if (cancelled) return;

          if (!response.ok) {
            throw new Error(`ElevenLabs error: ${response.status}`);
          }

          const data = await response.json();
          if (data.audioUrl) {
            audio = new Audio(data.audioUrl);
            murfAudioRef.current = audio;

            const words = textToNarrate.split(/\s+/);
            const totalDurationEst = words.length * 400; // 400ms per word estimate
            const isSilentFallback = data.audioUrl && data.audioUrl.endsWith("silent_placeholder.mp3");

            audio.addEventListener("play", () => {
              setIsAudioPlaying(true);
              if (isSilentFallback) {
                let wordIdx = 0;
                const timer = setInterval(() => {
                  if (audio && !audio.paused && !cancelled && wordIdx < words.length) {
                    setCurrentWordIndex(wordIdx);
                    wordIdx++;
                  } else {
                    clearInterval(timer);
                    setIsAudioPlaying(false);
                    setCurrentWordIndex(-1);
                  }
                }, 400);
              } else {
                const timer = setInterval(() => {
                  if (audio && !audio.paused && !cancelled) {
                    const estIndex = Math.floor((audio.currentTime / (audio.duration || (totalDurationEst / 1000))) * words.length);
                    setCurrentWordIndex(Math.min(words.length - 1, estIndex));
                  } else {
                    clearInterval(timer);
                  }
                }, 100);
              }
            });

            audio.addEventListener("ended", () => {
              if (!isSilentFallback) {
                setIsAudioPlaying(false);
                setCurrentWordIndex(-1);
              }
            });

            audio.addEventListener("pause", () => {
              setIsAudioPlaying(false);
            });

            await audio.play();
            return; // Success, exit
          }
        } catch (e) {
          console.warn("ElevenLabs failed, falling back to Murf:", e);
        }
      }

      // Tier 2: Murf Audio Translation Flow
      try {
        console.log("Playing narration with Murf...");
        const response = await authFetch(
          `${BACKEND_URL}/api/generate-speech`,
          {
            method: "POST",
            body: JSON.stringify({
              text: textToNarrate,
              voiceId: selectedLanguage.voiceId,
              format: "mp3",
              channelType: "MONO",
              sampleRate: 44100,
            }),
          }
        );

        if (cancelled) return;

        if (!response.ok) {
          throw new Error(`Murf error: ${response.status}`);
        }

        const data = await response.json();
        const audioUrl = data.audioFile;
        const wordTimingsData = data.wordDurations.map((w: { word: string; startMs: number; endMs: number }, i: number) => ({
          word: w.word,
          start: w.startMs / 1000,
          end: w.endMs / 1000,
          index: i,
        }));
        if (audioUrl) {
          audio = new Audio(audioUrl);
          murfAudioRef.current = audio;

          timeUpdateHandler = () => {
            if (!audio) return;
            const currentTime = audio.currentTime;
            const currentWord = wordTimingsData.find(
              (w: { start: number; end: number }) => currentTime >= w.start && currentTime <= w.end
            );
            if (currentWord) {
              setCurrentWordIndex(currentWord.index);
            }
          };

          audio.addEventListener("timeupdate", timeUpdateHandler);
          audio.addEventListener("play", () => {
            setIsAudioPlaying(true);
          });
          audio.addEventListener("pause", () => {
            setIsAudioPlaying(false);
          });
          audio.addEventListener("ended", () => {
            setIsAudioPlaying(false);
            setCurrentWordIndex(-1);
          });

          const playPromise = audio.play();
          playPromise?.catch(() => {
            const handleUserInteraction = () => {
              if (audio && !cancelled) {
                audio.play();
              }
              window.removeEventListener("click", handleUserInteraction);
              window.removeEventListener("keydown", handleUserInteraction);
            };
            window.addEventListener("click", handleUserInteraction, {
              once: true,
            });
            window.addEventListener("keydown", handleUserInteraction, {
              once: true,
            });
          });
          return; // Success, exit
        }
      } catch (e) {
        console.warn("Murf failed, falling back to Browser TTS:", e);
      }

      // Tier 3: Browser Web SpeechSynthesis Fallback
      if (!cancelled) {
        try {
          console.log("Playing narration with browser SpeechSynthesis...");
          const utterance = new SpeechSynthesisUtterance(textToNarrate);
          utterance.onstart = () => {
            setIsAudioPlaying(true);
          };
          utterance.onend = () => {
            setIsAudioPlaying(false);
            setCurrentWordIndex(-1);
          };
          utterance.onerror = () => {
            setIsAudioPlaying(false);
            setCurrentWordIndex(-1);
          };
          utterance.onboundary = (event) => {
            if (event.name === "word") {
              const charIndex = event.charIndex;
              const wordsBefore = textToNarrate.substring(0, charIndex).trim().split(/\s+/);
              setCurrentWordIndex(wordsBefore.length - 1);
            }
          };
          window.speechSynthesis.speak(utterance);
        } catch (e) {
          console.error("All text-to-speech options failed:", e);
        }
      }
    }

    const textToUse = translatedNarration || currentSlide.narration;
    if (textToUse) fetchAndPlayAudio();

    return () => {
      cancelled = true;
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
        if (timeUpdateHandler) {
          audio.removeEventListener("timeupdate", timeUpdateHandler);
        }
        audio.removeEventListener("ended", () => {});
      }
      if (murfAudioRef.current) {
        murfAudioRef.current.pause();
        murfAudioRef.current.currentTime = 0;
        murfAudioRef.current = null;
      }
      window.speechSynthesis.cancel();
    };
  }, [currentSlide.narration, translatedNarration, selectedLanguage, audioProvider]);

  const handleInitiateCall = async () => {
    setIsCallLoading(true);

    const phoneNumber = import.meta.env.VITE_PHONE_NUMBER;

    try {
      const response = await authFetch(
        `${BACKEND_URL}/api/vapi-call`,
        {
          method: "POST",
          body: JSON.stringify({
            customer: {
              number: phoneNumber,
            },
            metadata: {
              topic: "Vectors",
              narration:
                "Vectors are a fundamental concept in computing, especially in graphics programming and mathematical operations.",
            },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data?.id) {
        alert("📞 Call initiated! You'll receive a call shortly.");
      } else {
        alert("⚠ Call failed, no call ID returned.");
      }
    } catch (error: unknown) {
      console.error("❌ Call failed:", error);
      if (error instanceof Error) {
        alert(`❌ Vapi Error: ${error.message}`);
      } else {
        alert("❌ Unknown error. See console.");
      }
    } finally {
      setIsCallLoading(false);
    }
  };

  // Floating dock items
  const dockItems = [
    {
      title: "Notes",
      icon: <BookOpen className="h-full w-full text-white/80" />,
      href: "#",
      onClick: () => setShowNotesModal(true),
    },
    {
      title: "Call Tutor",
      icon: <Phone className="h-full w-full text-white/80" />,
      href: "#",
      onClick: () => setShowCallModal(true),
    },
  ];

  if (loading && jobId) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white p-6 relative overflow-hidden">
        {/* Background grid */}
        <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:30px_30px] pointer-events-none" />
        
        {/* Glowing blur effects */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative z-10 max-w-md w-full text-center space-y-8">
          <div className="space-y-3">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-400 via-violet-400 to-indigo-400 bg-clip-text text-transparent">
              Creating Your Lesson
            </h1>
            <p className="text-neutral-400 text-sm">
              We are generating customized visual animations and scripts for you.
            </p>
          </div>

          {/* Progress Bar */}
          <div className="relative pt-1">
            <div className="flex mb-2 items-center justify-between text-xs">
              <span className="text-neutral-400 font-medium">Progress</span>
              <span className="text-purple-400 font-bold">{jobProgress}%</span>
            </div>
            <div className="overflow-hidden h-2 text-xs flex rounded-full bg-white/10">
              <div
                style={{ width: `${jobProgress}%` }}
                className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-500"
              />
            </div>
          </div>

          <div className="p-4 bg-white/5 border border-white/10 rounded-xl">
            <p className="text-sm font-medium text-neutral-200 animate-pulse">{jobMessage}</p>
          </div>

          {jobError && (
            <div className="p-4 bg-red-500/15 border border-red-500/30 rounded-xl text-left space-y-3">
              <p className="text-sm text-red-400 font-semibold">Error Generating Lesson</p>
              <p className="text-xs text-red-300/80 leading-relaxed">{jobError}</p>
              <button
                onClick={() => setJobId(null)}
                className="w-full py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs font-semibold transition-all cursor-pointer"
              >
                Go Back to Chat
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Show a friendly error screen when lesson generation failed entirely
  if (!loading && !jobId && FetchData.length === 0) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white">Lesson Generation Failed</h2>
          <p className="text-neutral-400 text-sm leading-relaxed">
            The AI could not generate your lesson. This is usually caused by a missing or invalid API key,
            or the backend server is not running. Please check your <code className="text-purple-400">.env</code> file and try again.
          </p>
          <div className="p-4 bg-white/5 border border-white/10 rounded-xl text-left space-y-2">
            <p className="text-xs font-semibold text-neutral-300">Common Fixes:</p>
            <p className="text-xs text-neutral-400">• Set a valid <code className="text-yellow-400">GEMINI_API_KEY</code> or <code className="text-yellow-400">GOOGLE_API_KEY</code> in your .env</p>
            <p className="text-xs text-neutral-400">• Make sure both servers are running</p>
            <p className="text-xs text-neutral-400">• Restart after any .env changes</p>
          </div>
          <button
            onClick={() => navigate("/chat")}
            className="w-full py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-sm font-semibold transition-all cursor-pointer"
          >
            ← Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes wave-bar {
          0%, 100% { transform: scaleY(0.3); }
          50% { transform: scaleY(1.0); }
        }
        .animate-wave-bar {
          animation: wave-bar 1s ease-in-out infinite;
          transform-origin: bottom;
        }
        .animate-wave-bar-1 { animation-delay: 0.1s; }
        .animate-wave-bar-2 { animation-delay: 0.3s; }
        .animate-wave-bar-3 { animation-delay: 0.5s; }
        .animate-wave-bar-4 { animation-delay: 0.2s; animation-duration: 0.7s; }
        .animate-wave-bar-5 { animation-delay: 0.4s; }
      `}</style>
      <div className="min-h-screen w-full bg-black text-white flex flex-col lg:flex-row">
        {/* Dimension Continuity Dashboard Sidebar */}
        <div className="hidden lg:flex flex-col w-80 bg-zinc-900/30 backdrop-blur-md border-r border-white/10 p-6 flex-shrink-0 select-none overflow-y-auto space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-white/15 pb-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                Cosmos Dashboard
              </h2>
              <p className="text-xs text-neutral-400 font-mono">
                Seed: #{worldState?.world_seed ?? "4091-ALPHA"}
              </p>
            </div>
          </div>

          {/* XP Progress & Level Display */}
          <div className="space-y-3">
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Learning Level</span>
              <span className="text-xs font-bold text-purple-400">Level {userLevel}</span>
            </div>
            <div className="p-3.5 bg-white/5 border border-white/10 rounded-xl space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-neutral-400">Total XP</span>
                <span className="text-neutral-200 font-semibold">{totalXP} XP</span>
              </div>
              <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  style={{ width: `${totalXP % 100}%` }}
                  className="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full transition-all duration-500"
                />
              </div>
              <p className="text-[10px] text-neutral-400 text-right">
                {100 - (totalXP % 100)} XP to Next Level
              </p>
            </div>
          </div>

          {/* Leaderboard Accordion Widget */}
          <div className="space-y-2">
            <button
              onClick={() => setIsLeaderboardOpen(!isLeaderboardOpen)}
              className="w-full flex justify-between items-center text-[10px] font-bold text-neutral-500 uppercase tracking-widest hover:text-neutral-300 transition-colors"
            >
              <span>🏆 Global Leaderboard</span>
              <FiChevronDown
                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                  isLeaderboardOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {isLeaderboardOpen && (
              <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden divide-y divide-white/5 max-h-60 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
                {leaderboard.length > 0 ? (
                  leaderboard.map((player: any, idx: number) => {
                    const isCurrentUser = player.user_id === getCurrentUserId();
                    return (
                      <div
                        key={idx}
                        className={`flex items-center justify-between p-2 px-3 text-xs transition-colors ${
                          isCurrentUser
                            ? "bg-purple-500/10 text-purple-200"
                            : "text-neutral-300 hover:bg-white/5"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`font-bold w-4 text-center ${
                            player.rank === 1 ? "text-amber-400" :
                            player.rank === 2 ? "text-slate-300" :
                            player.rank === 3 ? "text-amber-600" : "text-neutral-500"
                          }`}>
                            {player.rank}
                          </span>
                          <span className="truncate max-w-[120px] font-mono">
                            {player.user_id === "defaultUser" ? "You (Default)" : player.user_id.slice(0, 8)}
                          </span>
                        </div>
                        <span className="font-semibold text-neutral-400">{player.score} XP</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-3 text-center text-neutral-500 text-xs">
                    No leaderboard data
                  </div>
                )}
                {userRank > 0 && !leaderboard.some(p => p.user_id === getCurrentUserId()) && (
                  <div className="flex items-center justify-between p-2 px-3 bg-purple-500/10 text-purple-200 text-xs font-semibold">
                    <div className="flex items-center gap-2">
                      <span className="w-4 text-center">#{userRank}</span>
                      <span>You</span>
                    </div>
                    <span>{totalXP} XP</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Co-op & Social Hub Accordion Widget */}
          <div className="space-y-2">
            <button
              onClick={() => setIsLobbyPanelOpen(!isLobbyPanelOpen)}
              className="w-full flex justify-between items-center text-[10px] font-bold text-neutral-500 uppercase tracking-widest hover:text-neutral-300 transition-colors"
            >
              <span>🤝 Co-op & Social Hub</span>
              <FiChevronDown
                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                  isLobbyPanelOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {isLobbyPanelOpen && (
              <div className="p-3 bg-white/5 border border-white/10 rounded-xl space-y-3 max-h-[22rem] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 text-xs">
                <div className="flex items-center gap-1.5 text-neutral-400">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="font-semibold">{onlinePeers.length + 1} online peer(s)</span>
                </div>

                {!currentLobbyId ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-neutral-500 font-bold uppercase">Create Study Lobby</label>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={newLobbyName}
                          onChange={(e) => setNewLobbyName(e.target.value)}
                          placeholder="Lobby name..."
                          className="flex-1 bg-white/5 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-white/30"
                        />
                        <button
                          onClick={createLobby}
                          disabled={!newLobbyName.trim()}
                          className="px-3 py-1.5 bg-white text-black hover:bg-neutral-200 disabled:opacity-50 font-bold rounded-lg cursor-pointer transition-colors"
                        >
                          Create
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] text-neutral-500 font-bold uppercase block">Active Lobbies</label>
                      {lobbies.length > 0 ? (
                        <div className="space-y-1.5">
                          {lobbies.map((lobby) => (
                            <div key={lobby.id} className="flex justify-between items-center p-2 bg-white/5 border border-white/5 rounded-lg">
                              <div>
                                <p className="font-semibold text-neutral-200 truncate max-w-[120px]">{lobby.name}</p>
                                <p className="text-[9px] text-neutral-400">{lobby.members?.length || 0} studying</p>
                              </div>
                              <button
                                onClick={() => joinLobby(lobby.id)}
                                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-[10px] font-bold text-white transition-colors cursor-pointer"
                              >
                                Join
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[10px] text-neutral-500 italic">No active lobbies. Create one to study together!</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center border-b border-white/10 pb-2">
                      <p className="font-bold text-indigo-400 truncate max-w-[140px] text-sm">{lobbyState?.name}</p>
                      <button
                        onClick={leaveLobby}
                        className="text-[10px] font-semibold text-red-400 hover:text-red-300 transition-colors"
                      >
                        Leave
                      </button>
                    </div>

                    <div className="p-2.5 bg-white/5 border border-white/10 rounded-lg space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-neutral-200">👹 {lobbyState?.bossName}</span>
                        <span className="text-[10px] text-neutral-400">{lobbyState?.bossHp} / {lobbyState?.bossMaxHp} HP</span>
                      </div>
                      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${Math.max(0, (lobbyState?.bossHp || 0))}%` }}
                          className={`h-full rounded-full transition-all duration-300 ${
                            lobbyState?.status === "defeated" ? "bg-emerald-500" : "bg-gradient-to-r from-red-500 to-orange-500"
                          }`}
                        />
                      </div>
                      <p className="text-[9px] text-neutral-400 leading-relaxed">
                        {lobbyState?.status === "defeated"
                          ? "🎉 Defeated! +100 XP awarded to all."
                          : "⚔ Correct answers damage the boss!"}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[10px] text-neutral-500 font-bold uppercase">Lobby Chat</label>
                      <div className="bg-black/20 border border-white/5 rounded-lg p-2 h-24 overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-thumb-white/10 flex flex-col">
                        {chatMessages.length > 0 ? (
                          chatMessages.map((msg) => {
                            const isMe = msg.senderId === getCurrentUserId();
                            return (
                              <div key={msg.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                                <span className="text-[8px] text-neutral-500 font-mono">
                                  {isMe ? "You" : msg.senderId.slice(0, 6)}
                                </span>
                                <span className={`px-2 py-1 rounded-lg max-w-[90%] break-words inline-block text-[10px] ${
                                  isMe ? "bg-indigo-600 text-white" : "bg-white/10 text-neutral-300"
                                }`}>
                                  {msg.text}
                                </span>
                              </div>
                            );
                          })
                        ) : (
                          <p className="text-[9px] text-neutral-500 italic m-auto">No messages. Say hello!</p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <input
                          type="text"
                          value={typedMessage}
                          onChange={(e) => setTypedMessage(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
                          placeholder="Send message..."
                          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-white/20"
                        />
                        <button
                          onClick={sendChatMessage}
                          disabled={!typedMessage.trim()}
                          className="px-2.5 py-1 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 text-[10px] cursor-pointer"
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Active Dimension */}
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Active Dimension</span>
            <div className="p-3.5 bg-white/5 border border-white/10 rounded-xl flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                <span className="text-indigo-400 text-sm">🌌</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-neutral-200">
                  {worldState?.current_dimension ?? "Ethereal Nexus"}
                </p>
                <p className="text-[10px] text-neutral-400 font-medium">Quantum Learning Path</p>
              </div>
            </div>
          </div>

          {/* Companion Affinity Bond */}
          <div className="space-y-3">
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Companion Bond</span>
              <span className="text-xs font-bold text-indigo-400">{worldState?.companion_relationship_score ?? 15}%</span>
            </div>
            <div className="space-y-2">
              <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  style={{ width: `${worldState?.companion_relationship_score ?? 15}%` }}
                  className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-500"
                />
              </div>
              <p className="text-[11px] text-neutral-400 italic">
                {worldState?.companion_relationship_score >= 80 ? "✨ Inseparable Soulmates" :
                 worldState?.companion_relationship_score >= 50 ? "🤝 Trusted Companions" :
                 worldState?.companion_relationship_score >= 25 ? "🌱 Growing Friendship" :
                 "🤝 Spark is getting to know you"}
              </p>
            </div>
          </div>

          {/* Unlocked Regions */}
          <div className="space-y-2.5">
            <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Unlocked Regions</span>
            <div className="space-y-2">
              {(worldState?.unlocked_regions && worldState.unlocked_regions.length > 0) ? (
                worldState.unlocked_regions.map((region: string, idx: number) => (
                  <div key={idx} className="flex items-center gap-2.5 px-3 py-2 bg-white/5 border border-white/5 rounded-lg text-xs text-neutral-300 hover:border-white/10 transition-colors">
                    <span className="text-emerald-400 text-xs">📍</span>
                    <span className="font-medium">{region}</span>
                  </div>
                ))
              ) : (
                <>
                  <div className="flex items-center gap-2.5 px-3 py-2 bg-white/5 border border-white/5 rounded-lg text-xs text-neutral-300">
                    <span className="text-emerald-400 text-xs">📍</span>
                    <span className="font-medium">Cosmic Gateway</span>
                  </div>
                  <div className="flex items-center gap-2.5 px-3 py-2 bg-white/5 border border-white/5 rounded-lg text-xs text-neutral-300">
                    <span className="text-neutral-500 text-xs">📍</span>
                    <span className="font-medium">Starlight Ridge</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Lore */}
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Dimension Lore</span>
            <div className="p-3 bg-white/5 border border-white/10 rounded-xl max-h-36 overflow-y-auto text-xs text-neutral-400 leading-relaxed scrollbar-thin scrollbar-thumb-white/10">
              {worldState?.world_lore_summary ?? "A floating sanctuary suspended in the quantum matrix, where knowledge translates directly into emotional energy."}
            </div>
          </div>

          {/* Voice Settings */}
          <div className="space-y-2.5 pt-4 border-t border-white/10">
            <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Voice Orchestrator</span>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-white/5 border border-white/10 rounded-xl">
              <button
                onClick={() => setAudioProvider("elevenlabs")}
                className={`py-1.5 px-2 rounded-lg text-[10px] font-semibold transition-all ${
                  audioProvider === "elevenlabs"
                    ? "bg-white text-black shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                ElevenLabs (HQ)
              </button>
              <button
                onClick={() => setAudioProvider("murf")}
                className={`py-1.5 px-2 rounded-lg text-[10px] font-semibold transition-all ${
                  audioProvider === "murf"
                    ? "bg-white text-black shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                Murf AI / TTS
              </button>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 relative flex flex-col items-center justify-center w-full min-h-screen bg-black p-4 md:p-8 overflow-y-auto">
        <div className="z-10 flex mb-8">
          <div
            className={cn(
              "group rounded-full border border-black/5 bg-neutral-900 text-base transition-all ease-in hover:cursor-pointer hover:bg-neutral-800 shadow-lg"
            )}
          >
            <AnimatedShinyText className="inline-flex items-center justify-center px-6 py-2.5 font-medium text-lg transition ease-out">
              <AnimatePresence mode="wait">
                <motion.span
                  key={currentSlideIndex}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  {currentSlide.title}
                </motion.span>
              </AnimatePresence>
            </AnimatedShinyText>
          </div>
        </div>
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentSlideIndex}
            custom={direction}
            variants={slideVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 w-full max-w-6xl"
          >
            {/* Box 1: Visual Carousel */}
            <div className="relative group overflow-hidden rounded-xl border border-white/10 md:col-span-2 h-72 md:h-96 bg-zinc-900/50 backdrop-blur-sm transition-all duration-300 hover:border-white/30 hover:bg-zinc-900/70">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 via-purple-500/20 to-pink-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]"></div>
              
              {/* Media Element Container */}
              <div className="h-full w-full flex items-center justify-center p-2 relative z-10">
                {loading ? (
                  <div className="text-white/70 flex flex-col items-center">
                    <svg
                      className="animate-spin h-10 w-10 text-white/30 mb-3"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <span className="text-sm text-neutral-400 mt-2">{jobMessage}</span>
                    <div className="w-48 bg-white/10 h-1.5 rounded-full overflow-hidden mt-3 border border-white/5">
                      <div 
                        className="bg-indigo-500 h-full transition-all duration-300 ease-out" 
                        style={{ width: `${jobProgress}%` }}
                      ></div>
                    </div>
                  </div>
                ) : mediaUrl ? (
                  isVideo ? (
                    <div className="w-auto h-auto flex items-center justify-center">
                      <video
                        src={mediaUrl}
                        autoPlay
                        muted
                        loop
                        className="object-contain rounded-lg max-h-[250px] md:max-h-[320px]"
                        key={mediaUrl}
                      ></video>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center p-2">
                      <img
                        src={mediaUrl}
                        alt={currentSlide.title}
                        className="max-w-full max-h-[250px] md:max-h-[320px] object-contain rounded-lg shadow-lg border border-white/5 bg-zinc-950/80"
                        key={mediaUrl}
                      />
                    </div>
                  )
                ) : (
                  <div className="text-white/70 flex flex-col items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-10 h-10 text-white/30">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v13.5A1.5 1.5 0 003.75 21z" />
                    </svg>
                    <span className="text-sm">Visual generating…</span>
                    <span className="text-xs text-white/40">Slide keys: {currentSlide ? Object.keys(currentSlide).join(', ') : 'none'}</span>
                  </div>
                )}
              </div>

              {/* Chevron Navigation Overlays */}
              {!loading && (FetchData.length > 0 || videoURLs.length > 0) && (
                <>
                  {/* Left Chevron */}
                  {currentSlideIndex > 0 && (
                    <button
                      onClick={handlePrevSlide}
                      className="absolute left-4 top-1/2 -translate-y-1/2 z-20 p-2.5 rounded-full bg-black/60 border border-white/10 text-white/70 hover:text-white hover:bg-black/80 hover:scale-110 active:scale-95 transition-all duration-200"
                      aria-label="Previous Slide"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                      </svg>
                    </button>
                  )}

                  {/* Right Chevron */}
                  {currentSlideIndex < Math.min(FetchData.length || videoURLs.length, 5) - 1 && 
                    (currentSlideIndex < maxReachedSlideIndex || isSlideCompleted) && (
                    <button
                      onClick={handleNextSlide}
                      className="absolute right-4 top-1/2 -translate-y-1/2 z-20 p-2.5 rounded-full bg-black/60 border border-white/10 text-white/70 hover:text-white hover:bg-black/80 hover:scale-110 active:scale-95 transition-all duration-200"
                      aria-label="Next Slide"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                    </button>
                  )}
                </>
              )}
              
              {/* Pagination Dots at Bottom Center */}
              {!loading && (FetchData.length > 0 || videoURLs.length > 0) && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex gap-2">
                  {Array.from({ length: Math.min(FetchData.length || videoURLs.length, 5) }).map((_, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        if (i <= maxReachedSlideIndex) {
                          setCurrentSlideIndex(i);
                          setSelectedAnswerIndex(null);
                          setHasAnswered(false);
                        }
                      }}
                      className={`h-2 rounded-full transition-all duration-300 ${
                        i === currentSlideIndex
                          ? "w-6 bg-indigo-500"
                          : i <= maxReachedSlideIndex
                          ? "w-2 bg-white/50 hover:bg-white/80"
                          : "w-2 bg-white/20 cursor-not-allowed"
                      }`}
                      disabled={i > maxReachedSlideIndex}
                    />
                  ))}
                </div>
              )}

              <div className="absolute inset-0 pointer-events-none border border-white/5 rounded-xl"></div>
              <div className="absolute -inset-px bg-gradient-to-r from-purple-500/30 via-transparent to-cyan-500/30 rounded-xl opacity-0 group-hover:opacity-100 blur-xl transition-opacity duration-500"></div>
            </div>
            {/* Narration Box */}
            <div className="relative group overflow-hidden rounded-xl border border-white/10 p-6 h-72 md:h-96 bg-zinc-900/50 backdrop-blur-sm transition-all duration-300 hover:border-white/30 hover:bg-zinc-900/70">
              <div className="absolute inset-0 bg-gradient-to-br from-green-500/20 via-emerald-500/20 to-teal-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]"></div>
              <div className="relative z-10 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="white"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="white"
                        className="w-4 h-4"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
                        />
                      </svg>
                    </div>
                    <h3 className="text-lg font-medium text-white">Narration</h3>
                  </div>

                  {isAudioPlaying && (
                    <div className="flex items-end gap-[3px] h-4 px-2">
                      <span className="w-[3px] bg-emerald-400 rounded-full animate-wave-bar animate-wave-bar-1 h-2" />
                      <span className="w-[3px] bg-emerald-400 rounded-full animate-wave-bar animate-wave-bar-2 h-4" />
                      <span className="w-[3px] bg-emerald-400 rounded-full animate-wave-bar animate-wave-bar-3 h-3" />
                      <span className="w-[3px] bg-emerald-400 rounded-full animate-wave-bar animate-wave-bar-4 h-5" />
                      <span className="w-[3px] bg-emerald-400 rounded-full animate-wave-bar animate-wave-bar-5 h-1.5" />
                    </div>
                  )}
                </div>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="flex-grow overflow-y-auto pr-2 text-white/70 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
                >
                  {isTranslating ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-white/50 flex flex-col items-center">
                        <svg
                          className="animate-spin h-6 w-6 text-white/30 mb-2"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        <span className="text-sm">Translating...</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-x-1 gap-y-2 leading-relaxed">
                      {narrationWords.map((word, idx) => {
                        const isHighlighted = currentWordIndex === idx;
                        const isPunctuation = /^[.,!?]$/.test(word);
                        return (
                          <span
                            key={idx}
                            className={`transition-all duration-200 ${
                              isHighlighted
                                ? "bg-white/20 px-1 rounded text-white"
                                : "text-white/70"
                            }`}
                            style={{
                              display: isPunctuation
                                ? "inline"
                                : "inline-block",
                              marginRight: isPunctuation ? "0" : "0.1rem",
                            }}
                          >
                            {word}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </motion.div>

                {/* Language Dropdown */}
                <div className="relative mt-3">
                  <button
                    onClick={() =>
                      setShowLanguageDropdown(!showLanguageDropdown)
                    }
                    className="flex items-center justify-between  px-3 py-2 text-xs bg-white/5 border border-white/10 rounded-lg text-white/70 hover:bg-white/10 hover:border-white/20 transition-all duration-200"
                  >
                    <span>{selectedLanguage.label}</span>
                    <FiChevronDown
                      className={`w-3 h-3 transition-transform duration-200 ${
                        showLanguageDropdown ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {showLanguageDropdown && (
                    <div className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-800 border border-white/10 rounded-lg shadow-lg z-20 overflow-hidden">
                      {LANGUAGE_OPTIONS.map((language) => (
                        <button
                          key={language.code}
                          onClick={() => handleLanguageChange(language)}
                          className={`w-full px-3 py-2 text-xs text-left hover:bg-white/10 transition-colors duration-200 ${
                            selectedLanguage.code === language.code
                              ? "bg-white/10 text-white"
                              : "text-white/70"
                          }`}
                        >
                          {language.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="absolute -inset-px bg-gradient-to-r from-green-500/30 via-transparent to-emerald-500/30 rounded-xl opacity-0 group-hover:opacity-100 blur-xl transition-opacity duration-500"></div>
            </div>
            {/* Box 2: MCQ Question & Answers */}
            <div className="relative group overflow-hidden rounded-xl border border-white/10 p-4 min-h-[18rem] h-auto bg-zinc-900/50 backdrop-blur-sm transition-all duration-300 hover:border-white/30 hover:bg-zinc-900/70">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 via-purple-500/20 to-cyan-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]"></div>
              <div className="relative z-10 flex flex-col h-full">
                <h3 className="text-xl font-medium text-white mb-3">
                  Question
                </h3>
                <p className="text-white/70 mb-4">{question}</p>
                <div className="space-y-3 flex-grow">
                  {answer.map((info: string, index: number) => (
                    <motion.button
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.3,
                        delay: index * 0.1,
                      }}
                      className={`w-full text-left px-4 py-2.5 rounded-lg border ${
                        (selectedAnswerIndex === index && correctAnswerIndex === index) || (currentSlideIndex < maxReachedSlideIndex && correctAnswerIndex === index)
                          ? "bg-green-500/30 border-green-500/50 text-white"
                          : selectedAnswerIndex === index
                          ? "bg-red-500/30 border-red-500/50 text-white"
                          : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:border-white/20"
                      } transition-all duration-200 ${
                        (hasAnswered || currentSlideIndex < maxReachedSlideIndex) && "cursor-default"
                      }`}
                      onClick={() => !hasAnswered && currentSlideIndex === maxReachedSlideIndex && handleAnswerClick(index)}
                      key={index}
                      disabled={hasAnswered || currentSlideIndex < maxReachedSlideIndex}
                    >
                      {info}
                    </motion.button>
                  ))}
                </div>
              </div>
              <div className="absolute -inset-px bg-gradient-to-r from-blue-500/30 via-transparent to-purple-500/30 rounded-xl opacity-0 group-hover:opacity-100 blur-xl transition-opacity duration-500"></div>
            </div>
            {/* Box 3: AI Chatbot */}
            <div className="md:col-span-1 h-full">
              <AIChatbot
                lessonTitle={currentSlide.title}
                lessonContent={currentSlide.narration || ""}
              />
            </div>
            {/* Box 4: Next button */}
            <div className="relative group overflow-hidden rounded-xl border border-white/10 p-6 bg-zinc-900/50 backdrop-blur-sm transition-all duration-300 hover:border-white/30 hover:bg-zinc-900/70">
              <div className="absolute inset-0 bg-gradient-to-br from-amber-500/20 via-orange-500/20 to-rose-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
              <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]"></div>
              <div className="h-full w-full flex items-center justify-center relative z-10">
                <HoverBorderGradient
                  containerClassName={`rounded-full ${
                    !isSlideCompleted && "opacity-50 pointer-events-none"
                  }`}
                  as="button"
                  className="bg-black text-white flex items-center space-x-2 px-6 py-3"
                  onClick={animatedNextSlide}
                >
                  <span>Next Lesson</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-5 h-5"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
                    />
                  </svg>
                </HoverBorderGradient>
              </div>
              <div className="absolute -inset-px bg-gradient-to-r from-amber-500/30 via-transparent to-rose-500/30 rounded-xl opacity-0 group-hover:opacity-100 blur-xl transition-opacity duration-500"></div>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Floating Dock - Right Side */}
        <div className="fixed right-5 top-1/2 -translate-y-1/2 z-50">
          <FloatingDock
            items={dockItems}
            desktopClassName="flex-col h-auto w-16"
            mobileClassName="flex-col h-auto w-16"
          />
        </div>

        {/* Call Modal */}
        {showCallModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-neutral-900 border border-white/10 rounded-2xl p-8 shadow-2xl w-[90%] max-w-md text-white backdrop-blur-md">
              <h2 className="text-xl font-semibold mb-4 text-white">
                Need help with this lesson?
              </h2>
              <p className="mb-6 text-neutral-400 leading-relaxed">
                We'll connect you with an AI tutor via phone call to solve your
                doubts live.
              </p>
              <div className="flex justify-end gap-3">
                <button
                  className="bg-transparent border border-white/20 text-white hover:bg-white/5 active:bg-white/10 px-6 py-2.5 rounded-full font-medium transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98]"
                  onClick={() => setShowCallModal(false)}
                  disabled={isCallLoading}
                >
                  Cancel
                </button>
                <button
                  className="bg-white text-black hover:bg-gray-100 active:bg-gray-200 px-6 py-2.5 rounded-full font-medium transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] flex items-center gap-2"
                  onClick={() => {
                    setShowCallModal(false);
                    handleInitiateCall();
                  }}
                  disabled={isCallLoading}
                >
                  {isCallLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="none"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                      Calling...
                    </>
                  ) : (
                    "Start Call"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Notes Modal */}
        {showNotesModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-6xl h-[85vh] text-white flex flex-col backdrop-blur-md">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b border-white/10 flex-shrink-0">
                <div className="flex items-center gap-3">
                  <BookOpen size={24} className="text-white/80" />
                  <h2 className="text-xl font-semibold text-white">
                    My Learning Notes
                  </h2>
                </div>
                <button
                  onClick={() => {
                    setShowNotesModal(false);
                    resetNoteForm();
                  }}
                  className="p-2 hover:bg-white/10 rounded-lg transition-colors text-white/60 hover:text-white "
                >
                  <FiX size={20} />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 flex overflow-hidden min-h-0">
                {/* Notes List */}
                <div className="w-1/2 border-r border-white/10 p-6 overflow-y-auto">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-medium text-white">
                      Saved Notes
                    </h3>
                    <button
                      onClick={() => {
                        setCurrentNote({ title: "", content: "" });
                        setIsEditingNote(false);
                        setEditingNoteId(null);
                      }}
                      className="bg-white/10 hover:bg-white/20 border border-white/20 text-white px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98]"
                    >
                      <FiEdit3 size={14} />
                      New Note
                    </button>
                  </div>

                  {notesLoading ? (
                    <div className="flex justify-center py-12">
                      <svg
                        className="animate-spin h-8 w-8 text-white/30"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="none"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                    </div>
                  ) : notes.length === 0 ? (
                    <div className="text-center py-12 text-neutral-400">
                      <BookOpen size={48} className="mx-auto mb-4 opacity-30" />
                      <p className="leading-relaxed">
                        No notes yet. Start taking notes to remember key
                        concepts!
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {notes
                        .sort(
                          (a, b) =>
                            new Date(b.timestamp).getTime() -
                            new Date(a.timestamp).getTime()
                        )
                        .map((note) => (
                          <div
                            key={note.id}
                            className="bg-white/5 border border-white/10 rounded-xl p-4 hover:bg-white/10 hover:border-white/20 transition-all duration-200 cursor-pointer transform hover:scale-[1.01]"
                            onClick={() => editNote(note)}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <h4 className="font-medium text-white truncate flex-1 mr-2 text-base">
                                {note.title}
                              </h4>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteNote(note.id);
                                }}
                                className="text-red-400 hover:text-red-300 p-1.5 hover:bg-red-500/10 rounded-lg transition-all duration-200"
                              >
                                <FiTrash2 size={14} />
                              </button>
                            </div>
                            <p className="text-neutral-400 text-sm mb-3 line-clamp-2 leading-relaxed">
                              {note.content}
                            </p>
                            <div className="flex items-center justify-between text-xs text-neutral-500">
                              <span className="bg-white/10 px-3 py-1.5 rounded-full border border-white/10">
                                {note.lessonTitle}
                              </span>
                              <span>
                                {new Date(note.timestamp).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* Note Editor */}
                <div className="w-1/2 flex flex-col">
                  {/* Editor Header */}
                  <div className="flex items-center justify-between p-6 border-b border-white/10 flex-shrink-0">
                    <h3 className="text-lg font-medium text-white">
                      {isEditingNote ? "Edit Note" : "New Note"}
                    </h3>
                    {isEditingNote && (
                      <button
                        onClick={resetNoteForm}
                        className="text-neutral-400 hover:text-white text-sm transition-colors duration-200"
                      >
                        Cancel Edit
                      </button>
                    )}
                  </div>

                  {/* Editor Content */}
                  <div className="flex-1 flex flex-col p-6 space-y-4 overflow-hidden">
                    {/* Title Input */}
                    <div className="flex-shrink-0">
                      <label className="block text-sm font-medium text-neutral-400 mb-2">
                        Note Title
                      </label>
                      <input
                        type="text"
                        value={currentNote.title}
                        onChange={(e) =>
                          setCurrentNote((prev) => ({
                            ...prev,
                            title: e.target.value,
                          }))
                        }
                        placeholder="Enter note title..."
                        className="w-full bg-white/5 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-neutral-500 focus:outline-none focus:border-white/40 focus:bg-white/10 transition-all duration-200"
                      />
                    </div>

                    {/* Content Textarea */}
                    <div className="flex-1 flex flex-col min-h-0">
                      <label className="block text-sm font-medium text-neutral-400 mb-2 flex-shrink-0">
                        Note Content
                      </label>
                      <textarea
                        value={currentNote.content}
                        onChange={(e) =>
                          setCurrentNote((prev) => ({
                            ...prev,
                            content: e.target.value,
                          }))
                        }
                        placeholder="Write your notes here..."
                        className="flex-1 bg-white/5 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-neutral-500 focus:outline-none focus:border-white/40 focus:bg-white/10 transition-all duration-200 resize-none"
                      />
                    </div>
                  </div>

                  {/* Editor Footer */}
                  <div className="flex-shrink-0 p-6 border-t border-white/10 space-y-4">
                    {/* Save Button */}
                    <button
                      onClick={saveNote}
                      disabled={
                        !currentNote.title.trim() ||
                        !currentNote.content.trim() ||
                        isSavingNote
                      }
                      className="w-full bg-white text-black hover:bg-gray-100 active:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 rounded-full font-medium transition-all duration-200 transform cursor-pointer flex items-center gap-2 justify-center"
                    >
                      {isSavingNote ? (
                        <>
                          <svg
                            className="animate-spin h-4 w-4"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                              fill="none"
                            ></circle>
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            ></path>
                          </svg>
                          Saving...
                        </>
                      ) : (
                        <>
                          <FiSave size={16} />
                          {isEditingNote ? "Update Note" : "Save Note"}
                        </>
                      )}
                    </button>

                    {/* Current Lesson Info */}
                    <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                      <p className="text-sm text-neutral-400 leading-relaxed">
                        📚 Current Lesson:{" "}
                        <span className="text-white font-medium">
                          {currentSlide.title}
                        </span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Boredom Intervention Overlay */}
        <AnimatePresence>
          {showBoredomOverlay && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className="bg-[#0f172a] border border-indigo-500/30 rounded-3xl p-8 max-w-lg w-full shadow-2xl relative"
              >
                <div className="flex flex-col items-center text-center">
                  <div className="w-16 h-16 rounded-full bg-indigo-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 mb-4 animate-bounce">
                    <Sparkles className="w-8 h-8 text-white" />
                  </div>
                  
                  <h3 className="text-2xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent mb-2">
                    Spark wants to check in!
                  </h3>
                  
                  <p className="text-slate-300 text-sm mb-6 leading-relaxed">
                    "Hey! I noticed your energy levels might be shifting. Let's adjust our session together to keep the magic alive!"
                  </p>

                  <div className="flex flex-col gap-3 w-full">
                    <button
                      onClick={async () => {
                        setIsUpdatingPacing(true);
                        try {
                          const paceUpdate = authFetch(`${BACKEND_URL}/api/profile/update`, {
                            method: "POST",
                            body: JSON.stringify({
                              curiosity_type: "Logical-Explorer",
                              learning_style: "Visual",
                              pacing_preference: "slow",
                              motivation_trigger: "Explorative"
                            })
                          });

                          const recoveryMilestone = authFetch(`${BACKEND_URL}/api/milestones`, {
                            method: "POST",
                            body: JSON.stringify({
                              milestone_type: "recovery_milestone",
                              concept_id: currentSlide.title,
                              description: "User adjusted learning pacing for recovery",
                              associated_sentiment: 0.5
                            })
                          });

                          const recoveryXP = authFetch(`${BACKEND_URL}/api/profile/xp`, {
                            method: "POST",
                            body: JSON.stringify({
                              xp_delta: 50,
                              source_type: "recovery_milestone"
                            })
                          });

                          await Promise.all([paceUpdate, recoveryMilestone, recoveryXP]);
                          fetchLeaderboardAndXP();
                          alert("Pacing slowed down to give you more breathing room! (+50 XP awarded for recovery milestone) 👍");
                        } catch (e) {
                          console.error(e);
                        } finally {
                          setIsUpdatingPacing(false);
                          setShowBoredomOverlay(false);
                        }
                      }}
                      disabled={isUpdatingPacing}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 px-4 rounded-xl transition duration-200 cursor-pointer disabled:opacity-50"
                    >
                      {isUpdatingPacing ? "Adjusting..." : "🐢 Slow down the pacing"}
                    </button>

                    <button
                      onClick={() => {
                        setShowBoredomOverlay(false);
                        navigate("/onboarding");
                      }}
                      className="w-full bg-purple-600 hover:bg-purple-500 text-white font-semibold py-3 px-4 rounded-xl transition duration-200 cursor-pointer"
                    >
                      🎮 Play a quick game
                    </button>

                    <button
                      onClick={() => {
                        setShowBoredomOverlay(false);
                      }}
                      className="w-full bg-slate-800 hover:bg-slate-700 text-white py-3 px-4 rounded-xl transition duration-200 cursor-pointer"
                    >
                      No, I'm okay! Keep going
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>
    </>
  );
};

export default LearningPage;
