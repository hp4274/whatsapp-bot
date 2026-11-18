import type { Guide } from '../guides';

export const school: Guide = {
  title: 'School guide',
  intro: 'Run attendance, homework, fees and parent messages from one school desk.',
  tasks: [
    {
      title: 'Set up your school',
      steps: [
        'Open School and click the Settings tab.',
        'Under Identity & timings, fill in School name, Gate cutoff and Homework send time.',
        'Under Automations, choose Auto-send absent alerts daily and the Absent alert time.',
        'Add your UPI id and Payee name for fee payments, then click Save settings.',
      ],
      tip: 'Turn on WhatsApp keyword commands so parents can text words like HOMEWORK or RESULT to get answers by themselves.',
    },
    {
      title: 'Add your students',
      steps: [
        'Open the Students tab.',
        'Click Add student, fill in Student name, Roll no., Class, Section and Parent WhatsApp, then click Add student.',
        'For many students, click Sample CSV, fill it in, then click Import CSV.',
        'If some rows fail, Rows that need fixing lists the row and the problem.',
      ],
      tip: 'Parent Phone in the CSV is the WhatsApp number that gets every message.',
    },
    {
      title: 'Give staff the right access',
      steps: [
        'Invite people from the Team page first.',
        'Open the Staff tab and pick a title for each person: Principal, Class teacher, Accounts or Front desk.',
        'Tick the classes a teacher handles, then click Save.',
      ],
      tip: 'Titles decide which school tabs each person can open.',
    },
    {
      title: 'Take attendance',
      steps: [
        'Open Attendance and pick the class at the top. Check the Date.',
        'Tap Present, Absent, Late or Excused for each student, or click Mark all present.',
        'Click Save attendance.',
        'You can also upload a sheet with Upload CSV / XLSX.',
      ],
    },
    {
      title: 'Tell parents their child is absent',
      steps: [
        'Save the attendance first.',
        'Under Notify parents of absent students, tick Also alert parents of late arrivals if you want.',
        'Click Notify parents, then Confirm.',
      ],
      tip: 'Parents who were already alerted for that day are skipped. From Overview, Send daily absent alerts covers all classes at once.',
    },
    {
      title: 'See a student\'s attendance for the month',
      steps: [
        'In Attendance, click the calendar button on the student\'s row.',
        'A calendar shows their days present and each absence.',
      ],
    },
    {
      title: 'Build the timetable',
      steps: [
        'Open Timetable, pick a class and click Edit (or Start with period 1).',
        'Click Add period for each period of the day.',
        'Click a cell, fill in Subject, Teacher and Room, then click Apply to grid.',
        'Click Save timetable. Use Export / Print for a printable copy.',
      ],
      tip: 'Leave Subject empty for a free period.',
    },
    {
      title: 'Tell parents about a changed or cancelled period',
      steps: [
        'In Timetable, click the period in the grid.',
        'Choose Changed or Cancelled and add a Note for parents.',
        'Tick Notify parents on WhatsApp and click the Mark button.',
      ],
    },
    {
      title: 'Send homework',
      steps: [
        'Open Homework and fill in Class, Subject, Title, Instructions and Due date.',
        'Attach a worksheet PDF or image if you have one.',
        'Choose Send now, or Schedule and pick the Send time today.',
        'Click Publish & send (or Schedule). Parent sees shows the message they get.',
      ],
      tip: 'Parents can also text HOMEWORK anytime to get today\'s list.',
    },
    {
      title: 'Publish a notice, holiday or exam',
      steps: [
        'Open Notices. Under Compose, pick Circular, Holiday, Event or Exam date sheet.',
        'Fill in Title, Message, Starts and Ends, and attach a circular if you like.',
        'Choose the Audience: All parents, Classes or Bus routes.',
        'Tick Broadcast on WhatsApp to send it now, or Schedule it with Send at.',
        'Click Publish & broadcast (or Publish to archive to only file it).',
      ],
      tip: 'Parents can text HOLIDAYS or EXAMS to get the upcoming list.',
    },
    {
      title: 'Send an urgent message to parents',
      steps: [
        'Open Broadcast and pick Emergency closure, Bus delay or General.',
        'Pick a ready message such as Heavy rain closure, or write your own Text.',
        'Choose Who receives it: All parents, Classes or Bus routes.',
        'Click Send, then Confirm send.',
      ],
    },
    {
      title: 'Add and collect fees',
      steps: [
        'Open Fees and click Fee for a student or Bulk for a class.',
        'Fill in Term, Amount and Due date, and a Pay link if you have one. Click Create.',
        'When a parent pays, click Mark paid, pick the Payment method and Confirm.',
      ],
      tip: 'Marking a fee paid sends the parent a receipt on WhatsApp automatically.',
    },
    {
      title: 'Remind parents about fees',
      steps: [
        'In Fees, filter by class, term or status.',
        'Tick the fees and click Remind selected.',
        'Or click All overdue or All pending to remind everyone in that group.',
      ],
    },
    {
      title: 'Approve or reject leave',
      steps: [
        'Open Leave. Requests come in when parents text LEAVE with a reason and dates.',
        'Click Approve or Reject, add a Note to parent if you like, then Confirm.',
      ],
      tip: 'The parent gets your decision on WhatsApp straight away.',
    },
    {
      title: 'Send exam results privately',
      steps: [
        'Open Results. Type the Exam name and pick the Class.',
        'Choose the marksheet CSV (roll, then one column per subject) and click Import.',
        'Check What one parent receives and the list below.',
        'Click Dispatch results privately to parents, then confirm.',
      ],
      tip: 'Each parent gets only their own child\'s result. They can text RESULT to get it again.',
    },
    {
      title: 'Open parent-teacher meeting slots',
      steps: [
        'Open PTM. Under Open new slots, set First slot starts, Minutes each and How many.',
        'Pick the Teacher and the Class, then click Create slots.',
        'Booked slots show under each day as parents book.',
      ],
      tip: 'Parents book an open slot by texting PTM on WhatsApp.',
    },
    {
      title: 'Check today at a glance',
      steps: [
        'Open Overview to see today\'s attendance, homework, pending leave and fees.',
        'Use Quick actions to send absent alerts, broadcast homework or send an emergency alert.',
        'Pick a class at the top to see one class, or All classes.',
      ],
    },
  ],
};
