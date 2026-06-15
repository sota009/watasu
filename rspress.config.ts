import { defineConfig } from "@rspress/core";
import { pluginLlms } from "@rspress/plugin-llms";

export default defineConfig({
  root: "docs-site",
  themeDir: "theme",
  title: "watasu docs",
  description: "Agent-native encrypted intake rail for personal-data handoff.",
  lang: "en",
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
        text: "Demo",
        link: "/demo-flow"
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
            },
            {
              text: "Target demo flow",
              link: "/demo-flow"
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
