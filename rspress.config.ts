import { defineConfig } from "@rspress/core";
import { pluginLlms } from "@rspress/plugin-llms";

export default defineConfig({
  root: "docs-site",
  title: "watasu docs",
  description: "Agent-native encrypted intake rail for personal-data handoff.",
  lang: "ja",
  plugins: [
    pluginLlms()
  ],
  themeConfig: {
    llmsUI: true,
    nav: [
      {
        text: "Guide",
        link: "/guide"
      },
      {
        text: "AI",
        link: "/ai-customers"
      },
      {
        text: "Security",
        link: "/security"
      },
      {
        text: "GitHub",
        link: "https://github.com/sota009/watasu"
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
              text: "Getting started",
              link: "/guide"
            },
            {
              text: "AI customers",
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
            },
            {
              text: "Deploy docs site",
              link: "/deploy"
            }
          ]
        }
      ]
    }
  }
});
