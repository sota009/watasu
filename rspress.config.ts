import { defineConfig } from "@rspress/core";
import { pluginLlms } from "@rspress/plugin-llms";

export default defineConfig({
  root: "docs-site",
  themeDir: "theme",
  title: "watasu docs",
  description: "Agent-native encrypted intake rail for personal-data handoff.",
  icon: "/favicon.svg",
  lang: "en",
  plugins: [
    pluginLlms()
  ],
  themeConfig: {
    darkMode: false,
    llmsUI: true,
    nav: [
      {
        text: "How it works",
        link: "/guide"
      },
      {
        text: "For agents",
        link: "/ai-customers"
      },
      {
        text: "Security",
        link: "/security"
      }
    ],
    sidebar: {
      "/": [
        {
          text: "Start",
          items: [
            {
              text: "Overview",
              link: "/"
            },
            {
              text: "How it works",
              link: "/guide"
            },
            {
              text: "For agents",
              link: "/ai-customers"
            }
          ]
        },
        {
          text: "Reference",
          items: [
            {
              text: "Protocol surfaces",
              link: "/protocol"
            },
            {
              text: "Security boundary",
              link: "/security"
            }
          ]
        }
      ]
    }
  }
});
