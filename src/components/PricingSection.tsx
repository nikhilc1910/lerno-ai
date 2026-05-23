import React from "react";
import { useNavigate } from "react-router-dom";

// ====== CONFIGURATION ======
const PRO_PLAN_PRICE_ID = import.meta.env.VITE_STRIPE_PRO_PLAN_PRICE_ID;
const STRIPE_CHECKOUT_API = import.meta.env.VITE_STRIPE_CHECKOUT_API;

// ===========================

const PricingComponent: React.FC = () => {
  const navigate = useNavigate();

  // Stripe checkout handler
  const handleProCheckout = async () => {
    try {
      const res = await fetch(STRIPE_CHECKOUT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId: PRO_PLAN_PRICE_ID }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert("Failed to create Stripe checkout session.");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    }
  };

  return (
    <section className="w-full flex flex-col items-center justify-center bg-black py-16 px-4 lg:px-8">
      {/* Pricing Title */}
      <h2 className="text-white text-5xl lg:text-6xl font-bold mb-8 leading-tight text-center">
        Pricing
      </h2>

      {/* Description Text Below Title */}
      <p className="text-gray-300 text-xl lg:text-2xl leading-relaxed mb-12 text-center max-w-4xl">
        Start learning for free. Upgrade only when you&apos;re ready to unlock
        advanced features, unlimited access, and deeper learning analytics.
      </p>

      {/* Pricing Cards */}
      <div className="w-full max-w-6xl flex flex-col md:flex-row gap-6 justify-center">
        {/* Free Tier */}
        <div className="bg-white rounded-3xl p-8 shadow-2xl flex-1 max-w-sm flex flex-col transform transition-all duration-300">
          <div className="mb-4">
            <h3 className="text-black font-semibold text-xl mb-2">Free Tier</h3>
            <div className="flex items-end mb-2">
              <span className="text-black text-4xl font-extrabold mr-2">
                ₹0
              </span>
              <span className="text-gray-500 text-sm mb-1">/month</span>
            </div>
            <p className="text-gray-700 mb-4">
              Ideal for students exploring personalized learning for the first
              time.
            </p>
          </div>

          <hr className="my-4 border-gray-200" />

          <ul className="space-y-3 mb-8 text-black text-base flex-grow">
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              AI-generated lessons
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Up to 10 topic requests/month
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Visual explanations
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Progress tracking
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              No credit card required
            </li>
          </ul>

          <button
            onClick={() => navigate("/signup")}
            className="w-full cursor-pointer bg-gray-200 text-gray-700 rounded-xl py-4 font-semibold hover:bg-gray-300 transition-all duration-300 shadow-lg hover:shadow-xl"
          >
            Get Started Free
          </button>
        </div>

        {/* Pro Plan */}
        <div className="bg-white rounded-3xl p-8 shadow-2xl flex-1 max-w-sm flex flex-col transform    transition-all duration-300 relative">
          {/* Popular Badge */}
          <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
            <span className="bg-black text-white px-6 py-2 rounded-full text-sm font-semibold shadow-lg">
              Most Popular
            </span>
          </div>

          <div className="mb-4 mt-4">
            <h3 className="text-black font-semibold text-xl mb-2">Pro Plan</h3>
            <div className="flex items-end mb-2">
              <span className="text-black text-4xl font-extrabold mr-2">
                ₹499
              </span>
              <span className="text-gray-500 text-sm mb-1">/month</span>
            </div>
            <p className="text-gray-700 mb-4">
              For learners or educators seeking deeper personalization and
              unlimited access.
            </p>
          </div>

          <hr className="my-4 border-gray-200" />

          <ul className="space-y-3 mb-8 text-black text-base flex-grow">
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Unlimited topic requests
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              AI-powered chatbot
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Premium support
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Cancel anytime
            </li>
            <li className="flex items-center">
              <span className="mr-3 text-purple-500 font-bold">✔</span>
              Advanced progress analytics
            </li>
          </ul>

          <button
            onClick={handleProCheckout}
            className="w-full cursor-pointer bg-black text-white rounded-xl py-4 font-semibold hover:bg-gray-800 transition-all duration-300 shadow-lg hover:shadow-xl"
          >
            Upgrade to Pro
          </button>
        </div>
      </div>
    </section>
  );
};

export default PricingComponent;
