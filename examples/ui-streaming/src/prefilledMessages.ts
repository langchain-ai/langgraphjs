export interface PrefilledMessage {
  content: string;
  type: "human" | "ai";
}

export function getPrefilledMessages(): PrefilledMessage[] {
  return [
    {
      type: "human",
      content:
        "I am planning a two-week trip to Japan in April with my partner. We like food, culture, cities, and countryside. Budget is about $5,000 total.",
    },
    {
      type: "ai",
      content:
        "April is excellent for cherry blossoms. A strong route is Tokyo, Kyoto, Hiroshima, Osaka, Hakone, then Tokyo again. The JR Pass becomes more useful once Hiroshima is included.",
    },
    {
      type: "human",
      content:
        "Add accommodation guidance and rough costs for Tokyo, Kyoto, Osaka, and Hakone.",
    },
    {
      type: "ai",
      content:
        "Tokyo works well in Shinjuku or Asakusa at $100-150 per night. Kyoto near Gion or Kyoto Station is convenient at $80-120. Osaka around Namba is good for food at $80-100. Hakone is worth one ryokan splurge around $150-200.",
    },
    {
      type: "human",
      content: "What food should we prioritize in each city?",
    },
    {
      type: "ai",
      content:
        "Prioritize sushi and ramen in Tokyo, kaiseki and matcha in Kyoto, takoyaki and okonomiyaki in Osaka, and Hiroshima-style okonomiyaki plus oysters around Hiroshima and Miyajima.",
    },
    {
      type: "human",
      content: "What etiquette should we know?",
    },
    {
      type: "ai",
      content:
        "Keep quiet on trains, avoid phone calls in transit, carry trash with you, remove shoes indoors, do not tip, and wash before entering onsen baths.",
    },
    {
      type: "human",
      content:
        "Please summarize the plan and include a simple budget calculation for food at $70 per day for two people over 14 days.",
    },
  ];
}
