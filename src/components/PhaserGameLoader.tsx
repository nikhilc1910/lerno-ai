import React, { useEffect, useRef } from "react";
import Phaser from "phaser";
import { tracker } from "../utils/BehavioralTracker";

interface PhaserGameLoaderProps {
  onComplete: (answers: Record<string, string>) => void;
}

export const PhaserGameLoader: React.FC<PhaserGameLoaderProps> = ({ onComplete }) => {
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    class OnboardingScene extends Phaser.Scene {
      private startTime = 0;
      private hoverTimes: Record<string, number> = {};
      private collectedAnswers: Record<string, string> = {};

      constructor() {
        super("OnboardingScene");
      }

      preload() {
        // Assets are generated dynamically via Phaser Graphics
      }

      create() {
        this.startTime = Date.now();

        // Title text
        this.add.text(400, 80, "Which magical creature do you want to explore with?", {
          fontSize: "24px",
          color: "#ffffff",
          fontFamily: "Outfit, Inter, sans-serif",
        }).setOrigin(0.5);

        // Subtitle instructions
        this.add.text(400, 125, "(Tap your choice to begin your journey!)", {
          fontSize: "15px",
          color: "#94a3b8",
          fontFamily: "Inter, sans-serif",
        }).setOrigin(0.5);

        // Choice 1: The Magic Owl (Logical/Explorer)
        this.createChoiceCard(200, 300, "Magic Owl", 0x3b82f6, "Logical-Explorer", "A wise explorer of patterns");

        // Choice 2: The Starry Dragon (Creative/Writer)
        this.createChoiceCard(400, 300, "Star Dragon", 0xec4899, "Creative-Writer", "A creator of constellations");

        // Choice 3: The Ocean Mermaid (Visual/Artist)
        this.createChoiceCard(600, 300, "Mermaid", 0x10b981, "Visual-Artist", "A designer of colorful depths");
      }

      createChoiceCard(x: number, y: number, name: string, color: number, id: string, desc: string) {
        const card = this.add.container(x, y);

        const bg = this.add.graphics();
        bg.fillStyle(0x0f172a, 1);
        bg.lineStyle(2, 0x4f46e5, 0.4);
        bg.fillRoundedRect(-85, -115, 170, 230, 16);
        bg.strokeRoundedRect(-85, -115, 170, 230, 16);
        card.add(bg);

        // Central visual bubble
        const bubble = this.add.circle(0, -30, 40, color);
        card.add(bubble);

        // Character initial
        const iconText = this.add.text(0, -30, name[0], {
          fontSize: "32px",
          color: "#ffffff",
          fontStyle: "bold",
        }).setOrigin(0.5);
        card.add(iconText);

        // Title
        const title = this.add.text(0, 35, name, {
          fontSize: "18px",
          color: "#ffffff",
          fontStyle: "bold",
          fontFamily: "Outfit, Inter, sans-serif",
        }).setOrigin(0.5);
        card.add(title);

        // Description
        const description = this.add.text(0, 70, desc, {
          fontSize: "11px",
          color: "#94a3b8",
          align: "center",
          wordWrap: { width: 140 },
        }).setOrigin(0.5);
        card.add(description);

        const hitArea = new Phaser.Geom.Rectangle(-85, -115, 170, 230);
        card.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);

        // Interaction event bindings
        card.on("pointerover", () => {
          this.hoverTimes[id] = Date.now();
          this.tweens.add({
            targets: card,
            scaleX: 1.05,
            scaleY: 1.05,
            duration: 150,
            ease: "Back.easeOut",
          });
          bg.clear();
          bg.fillStyle(0x1e293b, 1);
          bg.lineStyle(3, color, 1);
          bg.fillRoundedRect(-85, -115, 170, 230, 16);
          bg.strokeRoundedRect(-85, -115, 170, 230, 16);
        });

        card.on("pointerout", () => {
          if (this.hoverTimes[id]) {
            const hoverDuration = Date.now() - this.hoverTimes[id];
            tracker.trackCustomEvent("game_hover", {
              element_id: `choice_card_${id}`,
              hover_duration_ms: hoverDuration,
            });
            delete this.hoverTimes[id];
          }
          this.tweens.add({
            targets: card,
            scaleX: 1.0,
            scaleY: 1.0,
            duration: 150,
            ease: "Power2",
          });
          bg.clear();
          bg.fillStyle(0x0f172a, 1);
          bg.lineStyle(2, 0x4f46e5, 0.4);
          bg.fillRoundedRect(-85, -115, 170, 230, 16);
          bg.strokeRoundedRect(-85, -115, 170, 230, 16);
        });

        card.on("pointerdown", () => {
          const latency = Date.now() - this.startTime;

          // Track selection behavior
          tracker.trackCustomEvent("game_choice", {
            element_id: `creature_select_${id}`,
            response_latency_ms: latency,
          });

          this.collectedAnswers["creature"] = id;

          // Visual confirmation animation
          this.tweens.add({
            targets: card,
            scaleX: 0.95,
            scaleY: 0.95,
            duration: 100,
            yoyo: true,
            onComplete: () => {
              onComplete(this.collectedAnswers);
            }
          });
        });
      }
    }

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      width: 800,
      height: 500,
      parent: "phaser-game-container",
      backgroundColor: "#020617",
      scene: [OnboardingScene],
    };

    const game = new Phaser.Game(config);
    gameRef.current = game;

    return () => {
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, [onComplete]);

  return (
    <div className="flex flex-col items-center justify-center p-6 bg-slate-950 rounded-3xl border border-indigo-500/20 shadow-2xl max-w-4xl mx-auto my-6">
      <div 
        id="phaser-game-container" 
        className="rounded-2xl overflow-hidden border border-indigo-500/30 shadow-indigo-500/10 shadow-inner"
      />
    </div>
  );
};

export default PhaserGameLoader;
