/**
 * Pool of welcome-screen rants. One is picked at random per session
 * (module-level, so it stays stable if the backdrop hides and reappears).
 * Add more by appending to the array — no other code changes needed.
 */
export const welcomeRants: string[] = [
  // G — tight
  `This is a board-in screen, not a Microsoft Edge onboarding funnel. No sign-in, no default-browser ceremony, no Copilot upsell, no "are you sure you want to close this tab" modal that reopens when you dismiss it. Open a file — this screen leaves without making a scene.`,
  // H — mid-length
  `This is a board-in screen. Unlike Edge, it will not: demand a Microsoft account, beg to be your default, push Bing, suggest Copilot, or hold the close button hostage until you have agreed to three things. Just open a file. It gets out of the way. Ignore it entirely if you prefer — that is also a fully supported workflow.`,
];

export const sessionRant: string =
  welcomeRants[Math.floor(Math.random() * welcomeRants.length)];
