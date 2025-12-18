/**
 * Pre-filled conversation messages for demonstrating summarization.
 * This file is separate from agent.ts so it can be imported in the browser
 * without pulling in the langchain dependencies that require Node.js APIs.
 */

export interface PrefilledMessage {
  content: string;
  type: "human" | "ai";
}

/**
 * Generate pre-filled conversation history to demonstrate summarization.
 * This creates a lengthy conversation that will trigger the summarization middleware.
 */
export function getPrefilledMessages(): PrefilledMessage[] {
  return [
    {
      type: "human",
      content: "Hi! I'm planning a trip to Japan and need help organizing everything.",
    },
    {
      type: "ai",
      content: `Hello! I'd be happy to help you plan your trip to Japan! That's an exciting destination with so much to offer. To help you best, could you tell me:

1. When are you planning to travel?
2. How long will you be staying?
3. What are your main interests (culture, food, nature, technology, etc.)?
4. What's your approximate budget?
5. Will you be traveling solo or with others?`,
    },
    {
      type: "human",
      content: "I'm going in April for 2 weeks. I'll be traveling with my partner. We love food and culture, and we'd like to see both cities and countryside. Budget is around $5000 total for both of us.",
    },
    {
      type: "ai",
      content: `Perfect timing! April is wonderful for visiting Japan - you'll catch the cherry blossom season (sakura), which is absolutely magical. With 2 weeks and $5000 for two people, you have a good budget to work with.

Here's a suggested itinerary framework:

**Week 1 - Cities:**
- Days 1-4: Tokyo (Shibuya, Shinjuku, Asakusa, teamLab Borderless)
- Days 5-7: Kyoto (temples, geisha district, bamboo grove)

**Week 2 - Mix of City & Countryside:**
- Days 8-9: Nara & Osaka (deer park, street food)
- Days 10-11: Hakone or Takayama (hot springs, nature)
- Days 12-14: Back to Tokyo for departure

For food lovers, I'd highly recommend:
- Tsukiji Outer Market in Tokyo
- Nishiki Market in Kyoto
- Dotonbori in Osaka

Would you like me to dive deeper into any specific part of this plan?`,
    },
    {
      type: "human",
      content: "That sounds amazing! Can you tell me more about the JR Pass? Is it worth it?",
    },
    {
      type: "ai",
      content: `Great question! The Japan Rail Pass (JR Pass) is definitely worth considering for your itinerary.

**JR Pass Details:**
- 14-day pass costs approximately $450 USD per person
- Covers unlimited travel on JR trains including the Shinkansen (bullet trains)
- Also covers JR buses and the JR ferry to Miyajima

**For your route, the JR Pass would cover:**
1. Tokyo ↔ Kyoto Shinkansen (~$270 round trip per person)
2. Kyoto ↔ Nara (included)
3. Kyoto ↔ Osaka (included)
4. Tokyo ↔ Hakone (partially covered)

**Cost comparison:**
- Without JR Pass: ~$350-400 per person for all major routes
- With 14-day JR Pass: ~$450 per person

The JR Pass becomes more valuable if you:
- Take the Shinkansen multiple times
- Do side trips (like to Hiroshima or Kanazawa)

My recommendation: For your 2-week trip with the routes I suggested, the JR Pass is borderline worth it. If you add one more long-distance trip (like a day trip to Hiroshima), it becomes clearly worth it.

Would you like me to help optimize your route to maximize the JR Pass value?`,
    },
    {
      type: "human",
      content: "Yes, let's add Hiroshima! Also, what about accommodation recommendations?",
    },
    {
      type: "ai",
      content: `Excellent choice! Adding Hiroshima makes the JR Pass definitely worthwhile, and it's an incredibly meaningful destination.

**Updated Itinerary with Hiroshima:**
- Days 1-4: Tokyo
- Days 5-7: Kyoto
- Day 8: Day trip to Hiroshima & Miyajima (from Kyoto)
- Days 9-10: Nara & Osaka
- Days 11-12: Hakone
- Days 13-14: Tokyo

**Accommodation Recommendations:**

**Tokyo (Budget: ~$100-150/night for 2):**
- Shinjuku area: Great for nightlife and transport hub
- Asakusa area: Traditional feel, near temples
- Recommended: Tokyu Stay or Dormy Inn chains (great value)

**Kyoto (Budget: ~$80-120/night for 2):**
- Gion area: Traditional, near geisha district
- Kyoto Station area: Convenient for transport
- Consider: One night in a traditional ryokan (~$200-300)

**Osaka (Budget: ~$80-100/night for 2):**
- Namba/Dotonbori: Best for food and nightlife
- Recommended: Cross Hotel or Hotel Monterey

**Hakone (Budget: ~$150-200/night for 2):**
- Splurge on a ryokan with private onsen (hot spring bath)
- Recommended: Hakone Yuryo or Ichinoyu Honkan

**Total Accommodation Estimate:** ~$1,400-1,800 for 14 nights

Would you like specific booking tips or should we discuss food and dining options?`,
    },
    {
      type: "human",
      content: "Let's talk about food! What should we definitely try?",
    },
    {
      type: "ai",
      content: `Oh, you're in for a treat! Japanese cuisine is incredible, and each region has specialties. Here's your essential food guide:

**Must-Try Foods by Region:**

**Tokyo:**
- 🍣 Sushi - Tsukiji Outer Market for fresh breakfast sushi
- 🍜 Ramen - Try a late-night bowl at Ichiran (solo booth experience!)
- 🍱 Tempura - Tsunahachi in Shinjuku for affordable excellence
- 🥘 Wagyu beef - Satou in Kichijoji for A5 menchi katsu

**Kyoto:**
- 🍵 Kaiseki - Multi-course traditional dinner (splurge ~$100-150/person)
- 🍡 Matcha everything - Nakamura Tokichi for matcha desserts
- 🍢 Yudofu - Hot tofu in a broth (Junsei restaurant)
- 🥢 Obanzai - Home-style Kyoto cooking

**Osaka (Food Capital!):**
- 🐙 Takoyaki - Octopus balls from street vendors in Dotonbori
- 🥞 Okonomiyaki - Savory pancakes at Mizuno
- 🍢 Kushikatsu - Deep-fried skewers at Daruma
- 🦀 Kani Doraku - Famous crab restaurant

**Hiroshima:**
- 🍜 Hiroshima-style okonomiyaki - Layered, not mixed!
- 🦪 Oysters from Miyajima - Grilled fresh

**Pro Tips:**
1. Download Tabelog app (Japanese Yelp) for restaurant ratings
2. Make reservations for popular spots, especially kaiseki
3. Convenience store food (7-Eleven, Lawson) is surprisingly amazing
4. Try a depachika (department store basement food hall)

Budget for food: ~$50-80/day for two eating well but not extravagantly.

Shall I help with specific restaurant reservations or discuss cultural etiquette for dining?`,
    },
    {
      type: "human",
      content: "What about cultural etiquette I should know?",
    },
    {
      type: "ai",
      content: `Great question! Japanese culture has many nuances, and showing respect will enhance your experience. Here's what you need to know:

**General Etiquette:**
- 🙇 Bowing: A slight nod is fine for tourists, but matching their bow shows respect
- 🗣️ Volume: Speak quietly in public, especially on trains
- 📱 Phone calls: Never on trains or buses; texting is fine
- 🚮 Trash: No public bins; carry a small bag for your trash

**Restaurant Etiquette:**
- 🍜 Slurping noodles is encouraged - it shows appreciation!
- 🥢 Never stick chopsticks upright in rice (funeral ritual)
- 🥢 Don't pass food chopstick to chopstick
- 💰 No tipping - it can be considered rude
- 🙏 Say "Itadakimasu" before eating and "Gochisousama" after

**Temple & Shrine Etiquette:**
- 👟 Remove shoes when entering buildings
- 🚿 Purify at the temizuya (water basin): left hand, right hand, rinse mouth
- 🙏 At shrines: bow twice, clap twice, pray, bow once
- 📸 Ask before photographing inside temples

**Onsen (Hot Spring) Etiquette:**
- 🧼 Wash thoroughly before entering the bath
- 🚫 No swimsuits - baths are nude
- 🧴 Don't put towel in water
- 🤫 Keep quiet and relaxed
- ❌ Tattoos may be restricted (check ahead)

**Other Important Notes:**
- 💳 Cash is still king in many places
- 🛒 Stand on left side of escalators in Tokyo (right in Osaka)
- 🎁 Gift-giving is appreciated; bring something from home

Would you like me to teach you some useful Japanese phrases?`,
    },
    {
      type: "human",
      content: "Yes please! What phrases will be most helpful?",
    },
    {
      type: "ai",
      content: `Here are the most useful Japanese phrases for your trip! I'll include pronunciation guides.

**Essential Basics:**
- Hello: Konnichiwa (kon-nee-chee-wah)
- Thank you: Arigatou gozaimasu (ah-ree-gah-toh go-zai-mas)
- Excuse me/Sorry: Sumimasen (sue-mee-mah-sen)
- Please: Onegaishimasu (oh-neh-guy-shee-mas)
- Yes: Hai (hi) / No: Iie (ee-eh)

**At Restaurants:**
- Before eating: Itadakimasu (ee-tah-dah-kee-mas)
- After eating: Gochisousama deshita (go-chee-soh-sama desh-ta)
- Delicious!: Oishii! (oy-shee)
- Check please: Okaikei onegaishimasu (oh-kai-kei oh-neh-guy-shee-mas)
- Water please: Omizu kudasai (oh-mee-zoo koo-dah-sai)

**Getting Around:**
- Where is ___?: ___ wa doko desu ka? (wah doh-koh des kah)
- How much?: Ikura desu ka? (ee-koo-rah des kah)
- Train station: Eki (eh-kee)
- I don't understand: Wakarimasen (wah-kah-ree-mah-sen)

**Shopping:**
- Do you have ___?: ___ wa arimasu ka?
- I'll take this: Kore kudasai (koh-reh koo-dah-sai)
- Can I pay by card?: Kaado de ii desu ka?

**Emergencies:**
- Help!: Tasukete! (tas-keh-teh)
- I'm lost: Michi ni mayoimashita

**Pro Tip:** Most Japanese people appreciate any attempt to speak Japanese, even if imperfect. Don't be shy!

Would you like me to help with anything else for your trip planning?`,
    },
    {
      type: "human",
      content: "This is so helpful! Can you summarize everything we've discussed so I can save it?",
    },
    {
      type: "ai",
      content: `Absolutely! Here's a comprehensive summary of your Japan trip plan:

**📅 TRIP OVERVIEW**
- Duration: 2 weeks in April (cherry blossom season!)
- Travelers: You and your partner
- Budget: $5,000 total

**🗺️ ITINERARY**
1. Days 1-4: Tokyo
2. Days 5-7: Kyoto
3. Day 8: Hiroshima & Miyajima day trip
4. Days 9-10: Nara & Osaka
5. Days 11-12: Hakone
6. Days 13-14: Tokyo (departure)

**🚄 TRANSPORTATION**
- 14-day JR Pass: ~$450/person
- Covers all Shinkansen and most JR trains
- Worth it with Hiroshima added!

**🏨 ACCOMMODATION (~$1,400-1,800 total)**
- Tokyo: Shinjuku/Asakusa area, ~$100-150/night
- Kyoto: Near Gion, one ryokan night recommended
- Osaka: Namba/Dotonbori, ~$80-100/night
- Hakone: Ryokan with onsen, ~$150-200/night

**🍜 FOOD HIGHLIGHTS**
- Tokyo: Sushi, ramen, tempura
- Kyoto: Kaiseki, matcha, yudofu
- Osaka: Takoyaki, okonomiyaki, kushikatsu
- Hiroshima: Hiroshima-style okonomiyaki, oysters
- Budget: ~$50-80/day for two

**📝 KEY ETIQUETTE**
- Quiet on trains, no phone calls
- Slurp noodles, no tipping
- Remove shoes indoors
- Bow slightly to show respect

**🗣️ KEY PHRASES**
- Arigatou gozaimasu (thank you)
- Sumimasen (excuse me)
- Itadakimasu (before eating)
- Oishii (delicious!)

**💰 BUDGET BREAKDOWN**
- Flights: ~$1,500-2,000 (not discussed, but estimate)
- JR Pass: ~$900 (both)
- Accommodation: ~$1,400-1,800
- Food: ~$700-1,100
- Activities: ~$400-600

Is there anything you'd like me to add or clarify?`,
    },
  ];
}

