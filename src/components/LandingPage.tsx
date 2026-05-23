"use client";
import { useNavigate } from "react-router-dom";
import { WavyBackground } from "../ui/wavy-background";
import { ContainerScroll } from "../ui/container-scroll-animation";
import { HoverEffect } from "../ui/card-hover-effect";
import { AceternityButton } from "../ui/aceternity-button";
import AceternityNavbar from "@/components/AceternityNavbar";
import PricingComponent from "./PricingSection";
import Footer from "./Footer";

const content = {
  mainTitle: "Your AI Tutor, Anytime, Anywhere",
  mainSubtitle:
    "Adaptive lessons, intelligent recommendations, and seamless learning at your fingertips.",
  getStartedBtn: "Get Started Now",
  learnSmarterTitle: "Learn Smarter with Interactive AI",
  tryNowTitle: "Try Lerno.ai Now",
  featuresTitle: "Features",
  projects: [
    {
      title: "Transform Learning with Lerno",
      description:
        "Lerno is an AI-powered learning platform that personalizes education like never before. Dive into interactive lessons, real-time feedback, and hands-on exercises designed to enhance your understanding.",
    },
    {
      title: "AI-Powered Tutor at Your Fingertips",
      description:
        "Get real-time, AI-driven explanations for any topic. Our intelligent tutor ensures you grasp concepts quickly and efficiently.",
    },
    {
      title: "Engage with Interactive Visuals",
      description:
        "Learn through dynamic animations, visual breakdowns, and step-by-step guidance that make complex topics simple.",
    },
    {
      title: "Your Learning, Your Way",
      description:
        "Adaptive learning paths customize content to match your pace, helping you focus on areas that need improvement.",
    },
    {
      title: "Join a Thriving Learning Community",
      description:
        "Collaborate with peers, participate in discussions, and get expert guidance—all in one place.",
    },
    {
      title: "Start Your Learning Journey Today!",
      description:
        "Thousands of learners are already unlocking their potential with Lerno. Don't miss out!",
    },
  ],
};

const LandingPage = () => {
  const navigate = useNavigate();

  const handleButtonClick = () => {
    navigate("/chat");
  };

  return (
    <div className="bg-black relative min-h-screen">
      {/* Navbar at the top */}
      <AceternityNavbar />

      {/* Main Content */}
      <WavyBackground className="max-w-4xl mx-auto pb-40">
        <p className="text-5xl text-white font-bold inter-var text-center">
          {content.mainTitle}
        </p>
        <p className="text-base md:text-lg mt-4 text-white font-normal inter-var text-center">
          {content.mainSubtitle}
        </p>
        <div className="flex justify-center mt-8">
          <AceternityButton onClick={handleButtonClick}>
            {content.getStartedBtn}
          </AceternityButton>
        </div>
      </WavyBackground>

      <div className="flex flex-col overflow-hidden">
        <ContainerScroll
          titleComponent={
            <>
              <h1 className="text-4xl font-semibold text-white dark:text-white">
                {content.learnSmarterTitle} <br />
                <span className="text-4xl md:text-[6rem] font-bold mt-1 leading-none">
                  {content.tryNowTitle}
                </span>
              </h1>
            </>
          }
        >
          <img
            src="/src/assets/lerno01.png"
            height={720}
            width={1400}
            className="mx-auto rounded-2xl object-cover h-full object-left-top"
            alt="Lerno.ai Preview"
          />
        </ContainerScroll>
      </div>

      <h2 className="text-white text-center text-3xl font-bold">
        {content.featuresTitle}
      </h2>
      <div className="max-w-7xl mx-auto px-8 py-10">
        <HoverEffect items={content.projects} />
      </div>
      <PricingComponent />
      <Footer />
    </div>
  );
};

export default LandingPage;
