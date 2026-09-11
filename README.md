🎯 Interview Training Agent
An AI-powered interview preparation platform built on IBM watsonx Granite-4, with a full frontend UI, a Node.js/Express backend, and a watsonx Orchestrate native agent.
---
Architecture
```
frontend/         ← Standalone HTML/CSS/JS app (open in any browser)
backend/          ← Node.js + Express REST API → IBM watsonx
wxo/              ← watsonx Orchestrate agent spec + Python tools
```
---
Quick Start
1. Backend
```bash
cd backend
npm install
npm start
# API running on http://localhost:3001
```
The backend exposes three endpoints:
Method	Path	Description
POST	`/api/generate-questions`	Generate interview questions from a JD
POST	`/api/evaluate-answer`	Evaluate a candidate answer with AI feedback
POST	`/api/study-plan`	Generate a 2-week personalised study plan
2. Frontend
Open `frontend/index.html` directly in your browser. No build step needed.
The frontend calls `http://localhost:3001` by default. Change the `API` constant at the top of the `<script>` block if you deploy the backend elsewhere.
3. watsonx Orchestrate Agent (optional)
First create the credentials connection:
```bash
orchestrate connections create watsonx_api_key
orchestrate connections configure watsonx_api_key --env draft --type team --kind api_key
orchestrate connections set-credentials watsonx_api_key --env draft \
  --api-key SlFIAtajsWKfLs-z53g2uTrbb0Z0W6IRRewl9LJabRKG
```
Then import the tools and agent:
```bash
cd wxo
orchestrate tools import -k python -f interview_tools.py -r requirements.txt
orchestrate agents import -f interview-training-agent.yaml
```
---
Configuration
Variable	Value
Model	`ibm/granite-4-h-small`
Region	`eu-de`
Project ID	`1a0e8eaf-318d-4e43-bb1e-f40ece288624`
Watsonx URL	`https://eu-de.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29`
---
Features
📋 Generate Questions — paste any job description, get tailored technical + behavioural questions
🎤 Practice & Evaluate — answer questions and receive a score/10, strengths, improvements, and a model answer
📚 Study Plan — get a personalised 2-week day-by-day preparation schedule
💡 Interview Tips — role-specific and interview-type-specific advice
📊 Live Stats — tracks questions generated, answers evaluated, and average score
---
Security Note
Rotate the API key above before committing this repository to any public source control.
