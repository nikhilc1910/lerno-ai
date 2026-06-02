import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, ArrowRight, BookOpen, Trophy, Users, Heart } from "lucide-react";
import { useNavigate } from "react-router-dom";
import PhaserGameLoader from "./PhaserGameLoader";
import { authFetch } from "../lib/api";
import { tracker } from "../utils/BehavioralTracker";

export const OnboardingCinematic: React.FC = () => {
  const [step, setStep] = useState(0);
  const [motivation, setMotivation] = useState("");
  const [curiosityType, setCuriosityType] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleStartJourney = () => {
    tracker.trackCustomEvent("onboarding_start", {});
    setStep(1);
  };

  const selectMotivation = (type: string) => {
    tracker.trackCustomEvent("onboarding_motivation_select", { element_id: type });
    setMotivation(type);
    setStep(2); // Proceed to Phaser game
  };

  const handleGameComplete = async (answers: Record<string, string>) => {
    const creature = answers.creature || "Logical-Explorer";
    setCuriosityType(creature);
    setStep(3); // Go to DNA generation screen
    
    // Automatically trigger saving DNA profile
    await saveLearningDNA(creature);
  };

  const saveLearningDNA = async (curiosity: string) => {
    setIsSubmitting(true);
    try {
      // Map Phaser creature to learning style
      let learningStyle = "Visual";
      if (curiosity === "Logical-Explorer") learningStyle = "Kinesthetic";
      if (curiosity === "Creative-Writer") learningStyle = "Read-Write";

      const payload = {
        curiosity_type: curiosity,
        learning_style: learningStyle,
        motivation_trigger: motivation || "Explorative",
        pacing_preference: "medium"
      };

      await authFetch("/api/profile/update", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      tracker.trackCustomEvent("onboarding_complete", payload);
    } catch (err) {
      console.error("Failed to save learning DNA profile:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-[#030014] text-white flex flex-col items-center justify-center overflow-hidden font-sans">
      {/* Background radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.08)_0%,rgba(0,0,0,0)_70%)] pointer-events-none" />

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div
            key="step-intro"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="z-10 text-center max-w-2xl px-6 flex flex-col items-center"
          >
            <motion.div
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ repeat: Infinity, duration: 6, ease: "easeInOut" }}
              className="w-24 h-24 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/30 mb-8 border border-indigo-400/20"
            >
              <Sparkles className="w-12 h-12 text-white" />
            </motion.div>

            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-indigo-200 to-purple-400 bg-clip-text text-transparent mb-4">
              Welcome to Lerno.ai
            </h1>

            <p className="text-lg md:text-xl text-slate-400 leading-relaxed mb-10 max-w-lg">
              "Hi there! I am Spark, your AI companion. Together we'll unlock a magical learning world designed specifically for how your brain works!"
            </p>

            <motion.button
              whileHover={{ scale: 1.05, shadow: "0 0 25px rgba(99,102,241,0.5)" }}
              whileTap={{ scale: 0.98 }}
              onClick={handleStartJourney}
              className="flex items-center gap-3 bg-gradient-to-r from-indigo-600 to-purple-600 px-8 py-4 rounded-full font-bold text-lg shadow-lg shadow-indigo-500/20 hover:from-indigo-500 hover:to-purple-500 transition-all border border-indigo-400/30"
            >
              Let's Begin <ArrowRight className="w-5 h-5" />
            </motion.button>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div
            key="step-motivation"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="z-10 w-full max-w-4xl px-6"
          >
            <div className="text-center mb-12">
              <span className="text-xs font-semibold tracking-wider text-indigo-400 uppercase bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20">
                Discovery Gate 1/2
              </span>
              <h2 className="text-3xl md:text-4xl font-extrabold mt-3 bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
                What excites you most when playing or learning?
              </h2>
              <p className="text-slate-400 mt-2">Select the option that feels most like you.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                {
                  id: "Achievement-oriented",
                  title: "Winning Awards & Badges",
                  description: "Climbing leaderboards, completing quests, and unlocking rare achievements.",
                  icon: Trophy,
                  color: "from-amber-500/20 to-orange-500/20 border-amber-500/30 text-amber-400",
                },
                {
                  id: "Explorative",
                  title: "Uncovering Secrets & Lore",
                  description: "Exploring new paths, solving hidden mysteries, and asking 'why' about the world.",
                  icon: BookOpen,
                  color: "from-indigo-500/20 to-purple-500/20 border-indigo-500/30 text-indigo-400",
                },
                {
                  id: "Collaborative",
                  title: "Helping Friends Solve Puzzles",
                  description: "Teamwork, sharing rewards, and building things collaboratively with others.",
                  icon: Users,
                  color: "from-emerald-500/20 to-teal-500/20 border-emerald-500/30 text-emerald-400",
                },
              ].map((opt) => {
                const Icon = opt.icon;
                return (
                  <motion.button
                    key={opt.id}
                    whileHover={{ y: -6, scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => selectMotivation(opt.id)}
                    className={`flex flex-col items-center text-center p-8 rounded-3xl bg-gradient-to-b ${opt.color} border backdrop-blur-md hover:bg-slate-900/50 transition-all cursor-pointer`}
                  >
                    <div className="p-4 rounded-2xl bg-white/5 mb-6">
                      <Icon className="w-8 h-8" />
                    </div>
                    <h3 className="text-xl font-bold mb-3">{opt.title}</h3>
                    <p className="text-sm text-slate-400 leading-relaxed">{opt.description}</p>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div
            key="step-phaser"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="z-10 w-full max-w-4xl px-6 flex flex-col items-center"
          >
            <div className="text-center mb-4">
              <span className="text-xs font-semibold tracking-wider text-indigo-400 uppercase bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20">
                Discovery Gate 2/2
              </span>
              <h2 className="text-2xl font-bold mt-2 text-white">Choose Your Explorer Companion</h2>
            </div>
            <PhaserGameLoader onComplete={handleGameComplete} />
          </motion.div>
        )}

        {step === 3 && (
          <motion.div
            key="step-generating"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="z-10 text-center max-w-md px-6 flex flex-col items-center"
          >
            {isSubmitting ? (
              <>
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                  className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full mb-8"
                />
                <h2 className="text-2xl font-bold mb-2">Analyzing Behavioral Signals...</h2>
                <p className="text-slate-400">Mapping your attention patterns, pacing choices, and curiosity traits.</p>
              </>
            ) : (
              <>
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 100, damping: 10 }}
                  className="w-20 h-20 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-8"
                >
                  <Heart className="w-10 h-10" />
                </motion.div>
                <h2 className="text-3xl font-extrabold mb-3 bg-gradient-to-r from-emerald-400 to-teal-200 bg-clip-text text-transparent">
                  Learning DNA Generated!
                </h2>
                <div className="bg-slate-900/60 border border-white/5 rounded-2xl p-6 mb-8 text-left w-full">
                  <div className="flex justify-between py-2 border-b border-white/5">
                    <span className="text-slate-400">Curiosity Persona</span>
                    <span className="font-semibold text-indigo-400">{curiosityType}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-white/5">
                    <span className="text-slate-400">Motivation Trigger</span>
                    <span className="font-semibold text-purple-400">
                      {motivation.replace("-oriented", "")}
                    </span>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-slate-400">Learning Path Pacing</span>
                    <span className="font-semibold text-emerald-400">Adaptive</span>
                  </div>
                </div>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => navigate("/chat")}
                  className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 py-4 rounded-full font-bold text-lg shadow-lg hover:from-indigo-500 hover:to-purple-500 transition-all border border-indigo-400/30"
                >
                  Enter the Portal
                </motion.button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default OnboardingCinematic;
