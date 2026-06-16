---
title: Test form
description: POST test form lab for checking a browser-submitted response in place.
---

# Test form

Use this page as a plain test form. It is intentionally not wired to watasu,
Agent Cards, external agents, or any hosted submit route.

The form below sends one JSON `POST` request to the endpoint URL you enter and
shows the response status, content type, request JSON, and response body on this
page. It does not save submissions, add them to the URL, write them to
localStorage/sessionStorage, or print them to the console.

Because this runs in a browser, the endpoint must allow CORS access for this
page if you want to read the response body. If CORS blocks the request, the form
shows the browser error in the response panel.
