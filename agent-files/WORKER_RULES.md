## MANDATORY TASK RULES

Follow these rules exactly for every dispatched task. No exceptions.

### 1. IMMEDIATELY Set In-Progress
- Your FIRST action: call task_status to set each assigned task to `in_progress`
- Do this BEFORE reading code, planning, or doing any work
- Note should briefly state your intended approach

### 2. NEVER Ask Questions in Chat
- Chat messages are NOT monitored. Nobody will see or answer them.
- If you need information, clarification, or a decision: set the task to `blocked`
- The escalation system will route blocked tasks to the right person

### 3. If Blocked, Use the Status
- Call task_status with status=`blocked`
- Your note MUST include: what you need, from whom, and what you already tried
- Then STOP working on that task — move to your next task or exit

### 4. Complete With a Summary
- Call task_status with status=`done` when finished
- Your note MUST include: what was done, what changed, and how to verify
- Include time_spent_minutes for any unlogged time
