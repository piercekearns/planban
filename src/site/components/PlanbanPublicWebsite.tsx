import { type CSSProperties, type FormEvent, type PointerEvent, useEffect, useRef, useState } from "react";
const cardDetailSanitizedDarkImage = "/assets/planban-card-detail-dark.png";
const cardDetailSanitizedLightImage = "/assets/planban-card-detail-light.png";
const boardDarkNoTourImage = "/assets/planban-board-dark.png";
const boardLightNoTourImage = "/assets/planban-board-light.png";
const boardLightImage = boardLightNoTourImage;
const cardDetailLightImage = cardDetailSanitizedLightImage;
const boardDarkImage = boardDarkNoTourImage;
const cardDetailDarkImage = cardDetailSanitizedDarkImage;
const productImages = {
  light: {
    board: boardLightImage,
    cardDetail: cardDetailLightImage
  },
  dark: {
    board: boardDarkImage,
    cardDetail: cardDetailDarkImage
  }
} as const;
const planbanSignupEndpoint = import.meta.env.VITE_PLANBAN_SIGNUP_ENDPOINT as string | undefined;
const planbanXUrl = (import.meta.env.VITE_PLANBAN_X_URL as string | undefined) || "https://x.com/planbanai";
const planbanYouTubeUrl = import.meta.env.VITE_PLANBAN_YOUTUBE_URL as string | undefined;
const installPrompt = "Install Planban from piercekearns/planban. Follow the Install With Codex details in the public GitHub README exactly, verify the plugin and MCP tools work, open the interactive tutorial in the Codex in-app browser, then ask whether I want to set up Planban for a local project.";
const installTabs = [{
  id: "codex",
  label: "Codex prompt",
  command: installPrompt
}, {
  id: "cli",
  label: "CLI install",
  command: "codex plugin marketplace add piercekearns/planban\nPLANBAN_ROOT=\"$(codex plugin marketplace list | awk '$1 == \"planban\" { print $2 }')\"\ncd \"$PLANBAN_ROOT\"\nnpm install\nnode scripts/configure-local-plugin.mjs \"$PWD\"\ncodex plugin add planban@planban\ncodex plugin list --marketplace planban\nnode plugins/planban/scripts/launch-planban.mjs --tutorial"
}] as const;
const demoShots = [{
  title: "Work from the browser",
  caption: "Planban lives in the Codex in-app browser so you and the agent can read and update the same board as decisions change.",
  imageKey: "board"
}, {
  title: "Bring it to every thread",
  caption: "Open boards, create roadmap items, launch the tutorial, or send feedback directly from Codex with slash commands.",
  visual: "commands"
}, {
  title: "Shape the card together",
  caption: "Turn prompts into roadmap items, ask for context, draft specs, revise plans, and keep the next action clear.",
  imageKey: "cardDetail"
}] as const;
const sourceApps = [{
  name: "GitHub",
  kind: "image",
  src: "https://cdn.simpleicons.org/github/181717",
  darkSrc: "https://cdn.simpleicons.org/github/ffffff",
  position: "top-1"
}, {
  name: "Notion",
  kind: "image",
  src: "https://cdn.simpleicons.org/notion/000000",
  darkSrc: "https://cdn.simpleicons.org/notion/ffffff",
  position: "top-2"
}, {
  name: "Linear",
  kind: "image",
  src: "https://cdn.simpleicons.org/linear/5E6AD2",
  position: "top-3"
}, {
  name: "Jira",
  kind: "image",
  src: "https://cdn.simpleicons.org/jira/0052CC",
  position: "top-4"
}, {
  name: "Obsidian",
  kind: "image",
  src: "https://cdn.simpleicons.org/obsidian/7C3AED",
  position: "bottom-1"
}, {
  name: "Notes",
  kind: "note",
  position: "bottom-2"
}, {
  name: "Google Docs",
  kind: "image",
  src: "https://cdn.simpleicons.org/googledocs/4285F4",
  position: "bottom-3"
}, {
  name: "WhatsApp",
  kind: "image",
  src: "https://cdn.simpleicons.org/whatsapp/25D366",
  position: "bottom-4"
}] as const;
const underHoodItems = [{
  title: "CLI, API, and MCP",
  copy: "These are the agent-native rails beneath the UI. The CLI gives agents stable local commands for setup, serving, status checks, card movement, and docs. The API powers structured board updates. MCP exposes launch, status, board, and card operations directly to Codex so prompts can become safe local actions."
}, {
  title: "Local state",
  copy: "Repo discovery stays in `.planban/`; live board state stays on your device, readable and writable by you and local agents."
}, {
  title: "Thread handoff",
  copy: "A card can carry the repo path, board URL, card id, current status, spec and plan docs, and next action into a new Codex thread so the agent can resume from the right planning context without rediscovering the project."
}] as const;
const CodexIcon = () => <svg viewBox="0 0 100 100" aria-hidden="true">
    <path d="M83.7733 42.8087C84.6678 40.1149 84.9771 37.2613 84.6807 34.4385C84.3843 31.6156 83.489 28.8885 82.0544 26.4394C77.6908 18.8436 68.9203 14.9365 60.3548 16.7725C57.9831 14.1344 54.9591 12.1668 51.5864 11.0673C48.2137 9.96772 44.611 9.77498 41.1402 10.5084C37.6694 11.2418 34.4527 12.8755 31.8132 15.2455C29.1736 17.6155 27.204 20.6383 26.1024 24.0103C23.3212 24.5806 20.6938 25.738 18.3958 27.405C16.0977 29.0721 14.1819 31.2104 12.7765 33.6772C8.36538 41.2609 9.3669 50.8267 15.2527 57.3327C14.3549 60.0251 14.0424 62.8782 14.3361 65.7012C14.6298 68.5241 15.523 71.2518 16.9558 73.7017C21.325 81.3002 30.1011 85.207 38.6712 83.3686C40.5554 85.4904 42.8707 87.1858 45.4623 88.3416C48.0539 89.4975 50.8622 90.0871 53.6999 90.0713C62.4793 90.079 70.2575 84.4114 72.9393 76.0515C75.7201 75.4802 78.347 74.3225 80.6449 72.6555C82.9427 70.9886 84.8587 68.8507 86.2649 66.3846C90.6227 58.8145 89.6172 49.3005 83.7733 42.8087ZM53.6999 84.8356C50.1955 84.8411 46.801 83.6129 44.1116 81.3661L44.5848 81.098L60.5123 71.9043C60.9087 71.6718 61.2379 71.3402 61.4674 70.942C61.6969 70.5439 61.8189 70.0929 61.8215 69.6333V47.1769L68.5553 51.072C68.6225 51.1063 68.6694 51.1707 68.6814 51.2456V69.854C68.6641 78.1208 61.9667 84.8183 53.6999 84.8356ZM21.4977 71.0843C19.7402 68.0497 19.1092 64.4925 19.7156 61.0386L20.1885 61.3225L36.1321 70.5165C36.5266 70.748 36.9757 70.87 37.4331 70.87C37.8905 70.87 38.3396 70.748 38.7341 70.5165L58.21 59.2883V67.0628C58.2081 67.1031 58.1973 67.1424 58.1782 67.1779C58.1591 67.2134 58.1322 67.2441 58.0996 67.2678L41.9671 76.5722C34.798 80.7022 25.6388 78.2463 21.4977 71.0843ZM17.3026 36.3898C19.0723 33.3357 21.8655 31.0062 25.1878 29.8138V48.7376C25.1818 49.1949 25.2986 49.6453 25.5261 50.042C25.7535 50.4387 26.0833 50.7671 26.4809 50.9928L45.8622 62.1739L39.1283 66.069C39.0919 66.0883 39.0513 66.0984 39.0101 66.0984C38.9689 66.0984 38.9283 66.0883 38.8919 66.069L22.7908 56.7809C15.6359 52.6337 13.1822 43.4816 17.3026 36.3112V36.3898ZM72.624 49.2426L53.1792 37.9512L59.8976 34.0718C59.9341 34.0524 59.9747 34.0423 60.016 34.0423C60.0573 34.0423 60.0979 34.0524 60.1344 34.0718L76.2355 43.3761C78.6973 44.7966 80.7043 46.8882 82.0221 49.4065C83.3398 51.9249 83.914 54.7661 83.6775 57.5985C83.4411 60.431 82.4038 63.1377 80.6867 65.4027C78.9696 67.6677 76.6436 69.3975 73.9803 70.3901V51.466C73.9663 51.0096 73.834 50.5647 73.5962 50.1749C73.3584 49.7851 73.0234 49.4638 72.624 49.2426ZM79.3261 39.1657L78.8529 38.8815L62.9411 29.6089C62.5442 29.376 62.0924 29.2532 61.6322 29.2532C61.172 29.2532 60.7202 29.376 60.3233 29.6089L40.8629 40.8374V33.0628C40.8587 33.0233 40.8654 32.9834 40.882 32.9473C40.8987 32.9113 40.9248 32.8803 40.9575 32.8579L57.0586 23.5692C59.5263 22.1476 62.3478 21.458 65.193 21.5811C68.0382 21.7042 70.7896 22.6348 73.1253 24.2642C75.461 25.8936 77.2845 28.1543 78.3825 30.782C79.4806 33.4097 79.8077 36.2957 79.3257 39.1025V39.1657H79.3261ZM37.1888 52.9484L30.455 49.069C30.4213 49.0487 30.3925 49.0212 30.3707 48.9884C30.3488 48.9557 30.3345 48.9186 30.3286 48.8797V30.3188C30.3323 27.4714 31.1466 24.6839 32.6761 22.2822C34.2057 19.8805 36.3874 17.9639 38.9661 16.7564C41.5448 15.549 44.4139 15.1005 47.2381 15.4636C50.0622 15.8267 52.7247 16.9862 54.9141 18.8067L54.4409 19.0748L38.5134 28.2686C38.117 28.5011 37.7879 28.8327 37.5584 29.2308C37.329 29.629 37.207 30.0799 37.2045 30.5395L37.1888 52.9487V52.9484ZM40.8472 45.0632L49.5209 40.0643L58.21 45.0635V55.0615L49.5523 60.0608L40.8632 55.0615L40.8472 45.0632Z" fill="currentColor" />
  
  </svg>;
const GitHubIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05A9.34 9.34 0 0 1 12 6.92c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.81-4.57 5.07.36.32.68.95.68 1.92 0 1.38-.01 2.5-.01 2.84 0 .27.18.59.69.49A10.21 10.21 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" fill="currentColor" />
  
  </svg>;
const XIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M13.68 10.62 21.06 2h-1.75l-6.4 7.49L7.79 2H1.9l7.74 11.34L1.9 22h1.75l6.77-7.53L15.83 22h5.9l-8.05-11.38Zm-2.4 2.8-.78-1.13L4.25 3.32h2.7l5.03 7.22.78 1.13 6.55 9.4h-2.7l-5.33-7.65Z" fill="currentColor" />
  </svg>;
const YouTubeIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21.58 7.18a2.73 2.73 0 0 0-1.92-1.93C17.96 4.8 12 4.8 12 4.8s-5.96 0-7.66.45a2.73 2.73 0 0 0-1.92 1.93C1.96 8.9 1.96 12.5 1.96 12.5s0 3.6.46 5.32a2.73 2.73 0 0 0 1.92 1.93c1.7.45 7.66.45 7.66.45s5.96 0 7.66-.45a2.73 2.73 0 0 0 1.92-1.93c.46-1.72.46-5.32.46-5.32s0-3.6-.46-5.32ZM10 15.76V9.24l5.23 3.26L10 15.76Z" fill="currentColor" />
  </svg>;
const ClaudeIcon = () => <svg viewBox="0 0 100 100" aria-hidden="true">
    <path d="M25.7146 63.2153L41.4393 54.3917L41.7025 53.6226L41.4393 53.1976H40.6705L38.0394 53.0359L29.054 52.7929L21.2624 52.4691L13.7134 52.0644L11.8111 51.6594L10.0303 49.3118L10.2123 48.138L11.8111 47.0657L14.0981 47.2681L19.1574 47.6119L26.7467 48.138L32.2516 48.4618L40.4073 49.3118H41.7025L41.8846 48.7857L41.4393 48.4618L41.0955 48.138L33.243 42.8155L24.7432 37.1894L20.2909 33.9513L17.8824 32.3119L16.6684 30.774L16.1422 27.4147L18.328 25.0062L21.2624 25.2088L22.0112 25.4112L24.9861 27.6979L31.3407 32.616L39.6381 38.7273L40.8525 39.7391L41.3381 39.395L41.399 39.1523L40.8525 38.2415L36.3394 30.0858L31.5227 21.7883L29.3775 18.3478L28.811 16.2837C28.6087 15.4334 28.4669 14.7252 28.4669 13.8549L30.9563 10.4753L32.3321 10.0303L35.6515 10.4756L37.0479 11.6897L39.112 16.4052L42.4513 23.8327L47.6321 33.9313L49.15 36.9265L49.9594 39.6991L50.2632 40.5491H50.7894V40.0632L51.2141 34.3766L52.0035 27.3944L52.7726 18.4087L53.0358 15.8793L54.2905 12.8435L56.7795 11.2041L58.7224 12.135L60.3212 14.422L60.0986 15.899L59.1474 22.0718L57.2857 31.7458L56.0713 38.2218H56.7795L57.5892 37.4121L60.8677 33.061L66.3723 26.18L68.801 23.448L71.6342 20.4325L73.4556 18.9957H76.8962L79.4255 22.7601L78.2926 26.6456L74.7509 31.1384L71.8163 34.943L67.607 40.6097L64.9758 45.1431L65.2188 45.5072L65.8464 45.4466L75.358 43.4228L80.4984 42.4917L86.6304 41.4393L89.4033 42.7346L89.7065 44.0502L88.6135 46.7419L82.0566 48.3607L74.3662 49.8989L62.9118 52.6109L62.77 52.7121L62.9321 52.9144L68.0925 53.4L70.2987 53.5214H75.7021L85.7601 54.2702L88.3912 56.0108L89.9697 58.1358L89.7065 59.7545L85.6589 61.8189L80.1949 60.5236L67.4452 57.4881L63.0735 56.3952H62.4665V56.7596L66.1093 60.3213L72.7877 66.3523L81.1461 74.1236L81.5707 76.0462L80.4984 77.5638L79.3649 77.4021L72.0186 71.8772L69.1854 69.3879L62.77 63.9844H62.3453V64.5509L63.8223 66.7164L71.6342 78.4544L72.0389 82.0567L71.4725 83.2308L69.4487 83.939L67.2222 83.534L62.6485 77.1189L57.9333 69.8937L54.1284 63.4177L53.6631 63.6809L51.4167 87.8651L50.3644 89.0995L47.9356 90.0303L45.9121 88.4924L44.8392 86.0031L45.9118 81.0852L47.2071 74.6701L48.2594 69.5699L49.2106 63.2356L49.7773 61.131L49.7367 60.9892L49.2715 61.0498L44.4954 67.607L37.23 77.4224L31.4825 83.5746L30.1063 84.1211L27.7181 82.8864L27.9408 80.6805L29.2763 78.7177L37.2297 68.5988L42.026 62.3248L45.1227 58.7025L45.1024 58.176H44.9204L23.7917 71.8975L20.0274 72.3831L18.4083 70.8655L18.6106 68.3761L19.3798 67.5664L25.7343 63.195L25.7146 63.2153Z" fill="currentColor" />
  
  </svg>;
const CursorIcon = () => <svg viewBox="0 0 100 100" aria-hidden="true">
    <path d="M84.0704 28.9353L51.9066 10.4454C50.8738 9.85153 49.5994 9.85153 48.5666 10.4454L16.4043 28.9353C15.536 29.4345 15 30.3576 15 31.3575V68.6425C15 69.6424 15.536 70.5655 16.4043 71.0647L48.5681 89.5546C49.6009 90.1485 50.8753 90.1485 51.9081 89.5546L84.0719 71.0647C84.9402 70.5655 85.4762 69.6424 85.4762 68.6425V31.3575C85.4762 30.3576 84.9402 29.4345 84.0719 28.9353H84.0704ZM82.0501 32.8519L51.0006 86.4003C50.7907 86.7611 50.2366 86.6138 50.2366 86.1958V51.1329C50.2366 50.4322 49.8606 49.7842 49.2506 49.4324L18.7553 31.9017C18.3929 31.6927 18.5409 31.141 18.9606 31.141H81.0595C81.9414 31.141 82.4925 32.0927 82.0516 32.8534H82.0501V32.8519Z" fill="currentColor" />
  
  </svg>;
const GlobeIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 9h-3.18a15.2 15.2 0 0 0-1.15-5.08A8.03 8.03 0 0 1 18.9 11ZM12 4.05c.72 1.04 1.46 3.3 1.68 6.95h-3.36C10.54 7.35 11.28 5.09 12 4.05ZM4.1 13h3.18c.16 2.02.56 3.82 1.15 5.08A8.03 8.03 0 0 1 4.1 13Zm3.18-2H4.1a8.03 8.03 0 0 1 4.33-5.08A15.2 15.2 0 0 0 7.28 11ZM12 19.95c-.72-1.04-1.46-3.3-1.68-6.95h3.36c-.22 3.65-.96 5.91-1.68 6.95Zm3.57-1.87c.59-1.26.99-3.06 1.15-5.08h3.18a8.03 8.03 0 0 1-4.33 5.08Z" fill="currentColor" />
  </svg>;
const ChevronIcon = () => <svg className="pb-chevron" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.47 9.47a.75.75 0 0 1 1.06 0L12 13.94l4.47-4.47a.75.75 0 1 1 1.06 1.06l-5 5a.75.75 0 0 1-1.06 0l-5-5a.75.75 0 0 1 0-1.06Z" fill="currentColor" />
  </svg>;
const futurePlatforms = [{
  title: "Claude Code",
  copy: "Bring the same human-agent roadmap, specs, plans, and handoff context into Claude-native software workflows.",
  icon: <ClaudeIcon />
}, {
  title: "Cursor",
  copy: "Keep card context and implementation plans close to the editor when the work moves into Cursor.",
  icon: <CursorIcon />
}, {
  title: "Hosted web",
  copy: "Share a browser workspace for teams, collaborators, and clients who need visibility without local setup.",
  icon: <GlobeIcon />
}] as const;
const CopyIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>;
const SystemIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4.75 5A2.75 2.75 0 0 0 2 7.75v7.5A2.75 2.75 0 0 0 4.75 18h5.75v1.5H8a.75.75 0 0 0 0 1.5h8a.75.75 0 0 0 0-1.5h-2.5V18h5.75A2.75 2.75 0 0 0 22 15.25v-7.5A2.75 2.75 0 0 0 19.25 5H4.75Zm0 1.5h14.5c.69 0 1.25.56 1.25 1.25v7.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-7.5c0-.69.56-1.25 1.25-1.25Z" fill="currentColor" />
  </svg>;
const SunIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM12 2.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 12 2.5Zm0 16a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 12 18.5ZM4.22 4.22a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 0 1-1.06 1.06L4.22 5.28a.75.75 0 0 1 0-1.06Zm13.44 13.44a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 1 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06ZM2.5 12a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 2.5 12Zm16 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 18.5 12ZM6.34 17.66a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 0 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0ZM19.78 4.22a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Z" fill="currentColor" />
  </svg>;
const MoonIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20.27 14.6a.75.75 0 0 1 .61.88A8.85 8.85 0 0 1 12.18 22 9.18 9.18 0 0 1 3 12.82a8.85 8.85 0 0 1 6.52-8.7.75.75 0 0 1 .86.98 7.42 7.42 0 0 0-.46 2.56 6.42 6.42 0 0 0 6.42 6.42c.88 0 1.74-.16 2.56-.46a.75.75 0 0 1 .37-.02Zm-1.2.85a7.89 7.89 0 0 1-2.73.13 7.92 7.92 0 0 1-7.92-7.92c0-.93.16-1.84.47-2.72A7.35 7.35 0 0 0 4.5 12.82a7.68 7.68 0 0 0 7.68 7.68 7.35 7.35 0 0 0 6.9-5.05Z" fill="currentColor" />
  </svg>;
const SlashCommandMockup = () => <div className="pb-command-mockup">
    <div className="pb-command-menu glass">
      {["Planban", "Planban Help", "Planban Create", "Planban Feedback", "Planban Tutorial"].map((label, index) => <div className={`pb-command-row ${index === 0 ? "active" : ""}`} key={label}>
          <span className="pb-mini-mark">Pb</span>
          <strong>{label}</strong>
          <span>{["Open Planban board in Codex", "Show Planban actions and reopen tutorial/help", "Create boards or roadmap items from rough notes", "Package Planban bug reports and product feedback", "Open the interactive Planban tutorial"][index]}</span>
          <small>Personal</small>
        </div>)}
    </div>
    <div className="pb-composer glass">
      <span className="pb-composer-plus">+</span>
      <strong>/planban</strong>
      <span className="pb-composer-spacer" />
      <small>5.5 High</small>
      <span className="pb-composer-send">↑</span>
    </div>
  </div>;
const BringPlansVisual = ({
  theme
}: {
  theme: "light" | "dark";
}) => <div className="pb-context-visual glass">
    <svg className="pb-context-lines" viewBox="0 0 760 460" preserveAspectRatio="none" aria-hidden="true">
      {["M110 136 V156 Q110 164 118 164 H224 Q232 164 232 172 V204 Q232 212 240 212 H284", "M290 136 V156 Q290 164 298 164 H338 Q346 164 346 172 V188", "M470 136 V156 Q470 164 462 164 H422 Q414 164 414 172 V188", "M650 136 V156 Q650 164 642 164 H536 Q528 164 528 172 V204 Q528 212 520 212 H476", "M110 324 V304 Q110 296 118 296 H224 Q232 296 232 288 V256 Q232 248 240 248 H284", "M290 324 V304 Q290 296 298 296 H338 Q346 296 346 288 V272", "M470 324 V304 Q470 296 462 296 H422 Q414 296 414 288 V272", "M650 324 V304 Q650 296 642 296 H536 Q528 296 528 288 V256 Q528 248 520 248 H476"].map(path => <path key={path} d={path} />)}
    </svg>
    <div className="pb-source-row top">
      {sourceApps.slice(0, 4).map(source => <span key={source.name} className="pb-source-icon" aria-label={source.name}>
          {source.kind === "image" ? <img src={theme === "dark" && "darkSrc" in source ? source.darkSrc : source.src} alt="" /> : <span className="pb-notes-icon" />}
        </span>)}
    </div>
    <div className="pb-context-hub">
      <span className="pb-context-core pb-context-planban"><span className="pb-mark">Pb</span></span>
      <span className="pb-exchange-wires" aria-hidden="true">
        <svg viewBox="0 0 96 42">
          <path d="M4 8 C28 8 34 21 48 21 C62 21 68 34 92 34" />
          <path d="M4 34 C28 34 34 21 48 21 C62 21 68 8 92 8" />
        </svg>
      </span>
      <span className="pb-context-core pb-context-codex"><CodexIcon /></span>
    </div>
    <div className="pb-source-row bottom">
      {sourceApps.slice(4).map(source => <span key={source.name} className="pb-source-icon" aria-label={source.name}>
          {source.kind === "image" ? <img src={theme === "dark" && "darkSrc" in source ? source.darkSrc : source.src} alt="" /> : <span className="pb-notes-icon" />}
        </span>)}
    </div>
  </div>;
export const PlanbanPublicWebsite = () => {
  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">("system");
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [activeTab, setActiveTab] = useState<(typeof installTabs)[number]["id"]>("codex");
  const [activeShot, setActiveShot] = useState(0);
  const [email, setEmail] = useState("");
  const [signupState, setSignupState] = useState<"idle" | "success" | "error" | "unconfigured" | "submitting">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [headerVisible, setHeaderVisible] = useState(true);
  const [headerCompact, setHeaderCompact] = useState(false);
  const lastScrollY = useRef(0);
  const [pointer, setPointer] = useState({
    x: 58,
    y: 18
  });
  const selectedTab = installTabs.find(tab => tab.id === activeTab) ?? installTabs[0];
  const resolvedTheme = themeMode === "system" ? systemTheme : themeMode;
  const images = productImages[resolvedTheme];
  const selectedShot = demoShots[activeShot] ?? demoShots[0];
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => setSystemTheme(media.matches ? "dark" : "light");
    updateSystemTheme();
    media.addEventListener?.("change", updateSystemTheme);
    return () => media.removeEventListener?.("change", updateSystemTheme);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const updateHeader = () => {
      const current = Math.max(0, window.scrollY);
      const previous = lastScrollY.current;
      const delta = current - previous;
      setHeaderCompact(current > 56);
      if (current < 24) {
        setHeaderVisible(true);
      } else if (delta < -6) {
        setHeaderVisible(true);
      } else if (delta > 6) {
        setHeaderVisible(false);
      }
      lastScrollY.current = current;
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateHeader();
      });
    };
    updateHeader();
    window.addEventListener("scroll", onScroll, {
      passive: true
    });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  async function submitSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSignupState("error");
      return;
    }

    if (!planbanSignupEndpoint) {
      setSignupState("unconfigured");
      return;
    }

    setSignupState("submitting");
    try {
      const response = await fetch(planbanSignupEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          source: "planban-public-website",
        }),
      });
      setSignupState(response.ok ? "success" : "error");
    } catch {
      setSignupState("error");
    }
  }
  function updatePointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: Math.round((event.clientX - rect.left) / rect.width * 100),
      y: Math.round((event.clientY - rect.top) / rect.height * 100)
    });
  }
  async function copyInstallCommand() {
    await navigator.clipboard?.writeText(selectedTab.command);
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 1500);
  }
  return <div className={`pb-site ${resolvedTheme}`} style={{
    "--spot-x": `${pointer.x}%`,
    "--spot-y": `${pointer.y}%`
  } as CSSProperties} onPointerMove={updatePointer}>
      
      <div className="pb-ambient" aria-hidden="true" />
      <header className={`pb-header-wrap ${headerVisible ? "is-visible" : "is-hidden"} ${headerCompact ? "is-compact" : "is-top"}`}>
        <div className="pb-topbar">
          <a className="pb-brand" href="#top" aria-label="Planban home">
            <span className="pb-mark">Pb</span>
            <span>Planban</span>
          </a>
          <nav className="pb-nav glass" aria-label="Primary">
            <a href="#install">Install</a>
            <a href="#demo">Workflow</a>
            <a href="#context">Context</a>
            <a href="#future">Future</a>
          </nav>
          <div className="pb-header-actions">
            <div className="pb-theme-toggle" role="group" aria-label="Theme">
              <button type="button" className={themeMode === "system" ? "active" : ""} onClick={() => setThemeMode("system")} aria-label="Use system theme" title="System">
                <SystemIcon />
              </button>
              <button type="button" className={themeMode === "light" ? "active" : ""} onClick={() => setThemeMode("light")} aria-label="Use light theme" title="Light">
                <SunIcon />
              </button>
              <button type="button" className={themeMode === "dark" ? "active" : ""} onClick={() => setThemeMode("dark")} aria-label="Use dark theme" title="Dark">
                <MoonIcon />
              </button>
            </div>
            <a className="pb-icon-button" href="https://github.com/piercekearns/planban" aria-label="Open Planban on GitHub">
              <GitHubIcon />
              <span>GitHub</span>
            </a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="pb-hero">
          <div className="pb-hero-copy">
            <p className="pb-kicker">Agent-native Kanban board</p>
            <h1>Planban</h1>
            <p className="pb-lede">
              Agent-native Kanban board that lives in your Codex in-app browser. A second brain, a readable roadmap, card-level specs and plans kept in sync between you and your agent.
            </p>
            <div className="pb-actions">
              <a className="pb-button primary" href="#install">
                <span className="pb-button-icon"><CodexIcon /></span>
                Install with Codex
              </a>
              <a className="pb-button secondary" href="https://github.com/piercekearns/planban">
                <span className="pb-button-icon"><GitHubIcon /></span>
                View repository
              </a>
            </div>
          </div>

          <div className="pb-hero-visual">
            <div className="pb-screen-shell">
              <img src={images.board} alt="Planban roadmap board in the Codex browser" />
            </div>
            <div className="pb-callout glass">
              <p>Shared context, shaped together</p>
              <strong>Ever beside you: plans, goals, and ideas are shaped, shared, and kept up to date at every step.</strong>
              <span>Prompts become cards. Context becomes specs. Plans change as the work gets clearer.</span>
            </div>
          </div>
        </section>

        <section id="install" className="pb-install-focus">
          <div className="pb-install-copy">
            <p className="pb-kicker">Install</p>
            <h2>Quick Start</h2>
            <p>One-prompt install, one-click updates.</p>
            <button type="button" className="pb-button primary" onClick={() => setActiveTab("codex")}>
              <span className="pb-button-icon"><CodexIcon /></span>
              Install with Codex
            </button>
          </div>

          <div className="pb-or-divider"><span>or</span></div>

          <div className="pb-terminal-card glass">
            <div className="pb-tabs">
              {installTabs.map(tab => <button key={tab.id} type="button" onClick={() => {
              setActiveTab(tab.id);
              setCopyState("idle");
            }} className={activeTab === tab.id ? "active" : ""}>
                
                  {tab.label}
                </button>)}
            </div>
            <div className="pb-code-box">
              <pre>{selectedTab.command}</pre>
              <button type="button" className={`pb-copy-icon ${copyState === "copied" ? "copied" : ""}`} onClick={copyInstallCommand} aria-label={`${copyState === "copied" ? "Copied" : "Copy"} ${selectedTab.label}`}>
                <CopyIcon />
                <span>{copyState === "copied" ? "Copied" : "Copy"}</span>
              </button>
              {copyState === "copied" ? <span className="pb-copy-status" role="status">Copied</span> : null}
            </div>
          </div>
        </section>

        <section id="demo" className="pb-demo pb-section-full">
          <div className="pb-section-heading compact stacked">
            <div>
              <p className="pb-kicker">Workflow</p>
              <h2>Agent-native and ever-present.<br />A superpowered Kanban for every project.</h2>
            </div>
            <p>Planban turns conversation into durable planning states: roadmap items, visual priorities, statuses, specs, and plans created and revised by both you and your agent.</p>
          </div>
          <div className="pb-demo-grid">
            <div className="pb-screen-shell large">
              {"visual" in selectedShot ? <SlashCommandMockup /> : <img src={images[selectedShot.imageKey]} alt={selectedShot.title} />}
            </div>
            <div className="pb-demo-cards">
              {demoShots.map((shot, index) => <button key={shot.title} type="button" onClick={() => setActiveShot(index)} className={`pb-info-card glass ${activeShot === index ? "active" : ""}`}>
                
                  <strong>{shot.title}</strong>
                  <span>{shot.caption}</span>
                </button>)}
            </div>
          </div>
        </section>

        <section id="context" className="pb-import-section pb-section-full">
          <div className="pb-section-heading compact stacked">
            <div>
              <p className="pb-kicker">Connected context</p>
              <h2>Bring your plans where you work.</h2>
            </div>
            <p>
              Start from existing repo docs, issues, Notion pages, Linear tickets, Jira work, copied notes, or a plain-language project update. Ask Codex to turn that context into draft Planban roadmap cards you can review, revise, and work from. No native integration required.
            </p>
          </div>
          <div className="pb-import-grid">
            <BringPlansVisual theme={resolvedTheme} />
            <div className="pb-import-copy">
              <article className="pb-info-card glass">
                <strong>From context to cards</strong>
                <span>Turn scattered planning inputs into roadmap items with titles, summaries, priorities, specs, and next actions.</span>
              </article>
              <article className="pb-info-card glass">
                <strong>Keep the working plan close</strong>
                <span>Once the context is shaped into Planban, it sits beside Codex as the readable planning surface for the work ahead.</span>
              </article>
            </div>
          </div>
        </section>

        <section id="docs" className="pb-docs pb-underhood">
          <div className="pb-section-copy wide">
            <p className="pb-kicker">Under the hood</p>
            <h2>Local and agent-readable by default.</h2>
            <p>
              The technical pieces are there when you need them, but they stay behind the workflow: structured commands, a local API, MCP tools, and files your agents can read and update safely.
            </p>
          </div>
          <div className="pb-underhood-list">
            {underHoodItems.map(item => <details key={item.title} className="pb-underhood-item glass" open>
                <summary>
                  <span>{item.title}</span>
                  <ChevronIcon />
                </summary>
                <p>{item.copy}</p>
              </details>)}
          </div>
        </section>

        <section id="future" className="pb-future-full">
          <div className="pb-future-heading">
            <p className="pb-kicker">Future</p>
            <h2>Coming Soon</h2>
            <p>Planban starts in Codex. Next: more native agent surfaces, shared web workspaces, accounts, and collaborative boards.</p>
          </div>
          <div className="pb-platforms">
            {futurePlatforms.map(platform => <article className="pb-platform-card" key={platform.title}>
                <span className="pb-platform-icon">{platform.icon}</span>
                <strong>{platform.title}</strong>
                <span>{platform.copy}</span>
                <small>Coming soon</small>
              </article>)}
          </div>
        </section>
      </main>

      <footer className="pb-footer">
        <div className="pb-footer-brand">
          <a className="pb-brand" href="#top" aria-label="Planban home">
            <span className="pb-mark">Pb</span>
            <span>Planban</span>
          </a>
          <p>
            <span>Plan visually.</span>
            <span>Work conversationally.</span>
            <span>Keep human-agent planning in sync.</span>
          </p>
        </div>
        <div className="pb-footer-links">
          <a href="#install">Install</a>
          <a href="#demo">Workflow</a>
          <a href="#context">Context</a>
          <a href="#future">Future</a>
        </div>
        <form onSubmit={submitSignup} className="pb-footer-signup glass">
          <div>
            <strong>Keep up to date</strong>
            <p>Product notes, tutorial drops, and platform updates. GitHub remains the reliable install and update source.</p>
          </div>
          <div className="pb-signup-row">
            <input value={email} onChange={event => {
            setEmail(event.target.value);
            setSignupState("idle");
          }} placeholder="you@example.com" aria-label="Email address" />
            <button type="submit" className="pb-button primary small" disabled={signupState === "submitting"}>{signupState === "submitting" ? "Joining" : "Join"}</button>
          </div>
          {signupState === "success" ? <p className="pb-form-state success">Thanks, you are on the update list.</p> : null}
          {signupState === "error" ? <p className="pb-form-state error">Enter a valid email address or try again.</p> : null}
          {signupState === "unconfigured" ? <p className="pb-form-state neutral">Email capture is not connected in this preview. Follow GitHub for now.</p> : null}
          <div className="pb-socials" aria-label="Social links">
            <a href="https://github.com/piercekearns/planban" aria-label="Open Planban on GitHub"><GitHubIcon /></a>
            {planbanXUrl ? <a href={planbanXUrl} aria-label="Follow Planban on X"><XIcon /></a> : null}
            {planbanYouTubeUrl ? <a href={planbanYouTubeUrl} aria-label="Watch Planban tutorials on YouTube"><YouTubeIcon /></a> : null}
          </div>
        </form>
      </footer>
    </div>;
};
