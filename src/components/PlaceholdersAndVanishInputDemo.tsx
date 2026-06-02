import React, { useState } from "react";
import { PlaceholdersAndVanishInput } from "./PlaceholdersAndVanishInput";
import { SparklesCore } from "../ui/sparkles";
import { useNavigate } from "react-router-dom";
import { MultiStepLoader } from "@/ui/multi-step-loader";
import { authFetch } from "../lib/api";
import { toast } from "react-hot-toast";

export default function PlaceholdersAndVanishInputDemo() {
  const navigate = useNavigate();
  const [inputValue, setInputValue] = React.useState("");
  const [isLoading, setIsLoading] = useState(false);

  React.useEffect(() => {
    const checkProfile = async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
        const res = await authFetch(`${backendUrl}/api/profile`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.exists === false) {
            navigate("/onboarding");
          }
        }
      } catch (err) {
        console.error("Error checking profile:", err);
      }
    };
    checkProfile();
  }, [navigate]);

  const placeholders = [
    'I am "audience" teach me this "topic"?',
    "Explain the Pythagorean Theorem with animation",
    'I am "audience"  teach me this "topic"?',
    "Show me how derivatives work with graphs",
    "Give a visual explanation of linear transformations in 3D",
  ];
  const loadingStates = [
    { text: "Understanding your topic..." },
    { text: "Building scenes with Gemini AI..." },
    { text: "Crafting questions for you..." },
    { text: "Almost ready..." },
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const topic = inputValue.trim();

    // Length guards
    if (topic.length < 3) {
      toast.error("Topic too short — try something like \"Explain Newton's Laws\"");
      return;
    }
    if (topic.length > 200) {
      toast.error(`Topic too long — ${topic.length}/200 characters`);
      return;
    }

    // Basic injection guard (mirrors server-side check for instant UX feedback)
    const injectionPhrases = [
      "ignore previous", "ignore all", "system prompt",
      "jailbreak", "act as", "you are now", "disregard"
    ];
    const lower = topic.toLowerCase();
    if (injectionPhrases.some((p) => lower.includes(p))) {
      toast.error("Please enter a real learning topic");
      return;
    }

    setIsLoading(true);

    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

      // ── Primary path: Gemini instant lesson generation (seconds, no Manim) ──
      const geminiResponse = await authFetch(`${backendUrl}/api/generate-lesson-gemini`, {
        method: "POST",
        body: JSON.stringify({ topic }),
      });

      if (geminiResponse.ok) {
        const geminiData = await geminiResponse.json();
        const scenes = geminiData.scenes || [];

        if (scenes.length > 0) {
          navigate("/learning", {
            state: {
              query: inputValue,
              responseData: scenes,
              metadata: geminiData.metadata,
            },
          });
          return;
        }
      }

      // ── Fallback path: Manim async pipeline (if Gemini fails) ──
      console.warn("Gemini generation failed, falling back to Manim pipeline...");
      const maninResponse = await authFetch(`${backendUrl}/api/input-data`, {
        method: "POST",
        body: JSON.stringify({ topic, data: topic }),
      });
      const maninData = await maninResponse.json();
      const jobId = maninData.response?.job_id;

      navigate("/learning", {
        state: {
          query: inputValue,
          jobId: jobId || null,
          responseData: maninData.response?.data?.scenes || [],
        },
      });
    } catch (error) {
      console.error("Lesson generation error:", error);
      toast.error("Could not generate lesson. Check your connection and try again.");
      setIsLoading(false);
    }
  };
  //Making the component

  return (
    <div className="h-screen relative w-full bg-black flex flex-col items-center justify-center overflow-hidden rounded-md">
      <div className="w-full absolute inset-0 h-screen">
        <SparklesCore
          id="tsparticlesfullpage"
          background="transparent"
          minSize={0.6}
          maxSize={1.4}
          particleDensity={100}
          className="w-full h-full"
          particleColor="#FFFFFF"
        />
      </div>
      <h2 className="mb-10 text-md text-center sm:text-5xl text-white ">
        What do you want to learn?
      </h2>
      <PlaceholdersAndVanishInput
        placeholders={placeholders}
        onChange={handleChange}
        onSubmit={onSubmit}
      />
      <div className="text-zinc-400 text-xs mt-2 z-20">
        {inputValue.length}/200
      </div>

      {isLoading && (
        // <div className="mt-6 flex flex-col items-center">
        //   <l-ring-2
        //     size="40"
        //     stroke="5"
        //     stroke-length="0.25"
        //     bg-opacity="0.1"
        //     speed="0.8"
        //     color="white"
        //   ></l-ring-2>
        //   <p className="mt-2 text-white">
        //     Generating your learning experience...
        //   </p>
        // </div>
        <MultiStepLoader
          loadingStates={loadingStates}
          loading={isLoading}
          duration={5000}
          loop={true}
        />
      )}
    </div>
  );
}
