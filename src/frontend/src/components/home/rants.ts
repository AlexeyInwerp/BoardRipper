/**
 * Pool of welcome-screen rants. One is picked at random per session
 * (module-level, so it stays stable if the backdrop hides and reappears).
 * Add more by appending to the array — no other code changes needed.
 */
export const welcomeRants: string[] = [
  // G — tight
  `Fun fact: you need fewer clicks to download and install Firefox if you simply use Win + R → explorer "https://mozilla.org/firefox" than if you go through the Edge onboarding screen. `,
  `The worst fault to diagnose is the open line between the chair and the board.`,
  `OL is  often interpreted as Open Line or Over Limit. I figured it might mean Zero Life.`,

  // H — mid-length
  `A MacBook, a ThinkPad, and a Surface walk into a bar.

The bartender says, “What happened to you guys?”

The MacBook says, “Nothing, really. Just a little liquid damage.”

Bartender says, “Beer?”

MacBook says, “No, no… more like… atmosphere.”

The ThinkPad says, “I’ve got a CPU issue.”

Bartender says, “Overheating!”

ThinkPad goes, “No, it’s more… philosophical. Some days it’s connected, some days it’s exploring other options.”

And the Surface—

Well, the Surface doesn’t say anything.

Bartender says, “What’s your problem?”

Surface says, “I don’t have one.”

Bartender says, “Then why are you here?”

Surface says, “I just stopped working.”

Bartender goes, “That’s it?”

Surface says, “Yeah. I’m not a complicated machine.”`,
];

export const sessionRant: string =
  welcomeRants[Math.floor(Math.random() * welcomeRants.length)];
