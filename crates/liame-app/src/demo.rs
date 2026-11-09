//! Synthetic content only. All addresses use the reserved .invalid domain.
pub struct Message {
    pub sender: &'static str,
    pub initials: &'static str,
    pub email: &'static str,
    pub subject: &'static str,
    pub preview: &'static str,
    pub time: &'static str,
    pub body: &'static [&'static str],
}

pub const MESSAGES: &[Message] = &[
    Message {
        sender: "Alex Morgan",
        initials: "AM",
        email: "alex@example.invalid",
        subject: "A few thoughts on the new direction",
        preview: "The quieter layout is working really well. A couple of small things…",
        time: "10:42",
        body: &[
            "Hey,",
            "I spent some time with the latest version this morning. The quieter layout is working really well — it feels much easier to settle in and read.",
            "A couple of small things: give the message list a little more breathing room, and keep the sender details close to the subject. Everything else can stay out of the way.",
            "Happy to take another look when you have the next version ready.",
            "Alex",
        ],
    },
    Message {
        sender: "Sam Chen",
        initials: "SC",
        email: "sam@example.invalid",
        subject: "Notes from this morning",
        preview: "I've pulled together the decisions and next steps from our chat.",
        time: "09:18",
        body: &[
            "Hi,",
            "I've pulled together the decisions from our chat. Let's keep the first release focused on the everyday mail workflow: read, reply, search and archive.",
            "I'll send over the remaining notes tomorrow.",
            "Sam",
        ],
    },
    Message {
        sender: "Jamie Taylor",
        initials: "JT",
        email: "jamie@example.invalid",
        subject: "Friday lunch?",
        preview: "There's a new place around the corner that looks worth a try.",
        time: "Yesterday",
        body: &[
            "Hey!",
            "Are you free for lunch on Friday? There's a new place around the corner that looks worth a try.",
            "Around 12:30 would work for me. Let me know what suits.",
            "Jamie",
        ],
    },
    Message {
        sender: "Studio North",
        initials: "SN",
        email: "hello@example.invalid",
        subject: "Your November reading list",
        preview: "Five things we've been reading, making and thinking about.",
        time: "Yesterday",
        body: &[
            "Hello,",
            "This month we've been thinking about tools that leave more room for the work. Fewer interruptions, clearer defaults and a little more care in the details.",
            "Thanks for reading.",
            "Studio North",
        ],
    },
    Message {
        sender: "Robin Ellis",
        initials: "RE",
        email: "robin@example.invalid",
        subject: "Weekend plans",
        preview: "The forecast is looking good. Shall we head out early?",
        time: "Mon",
        body: &[
            "Hi,",
            "The forecast is looking good for the weekend. Shall we head out early and make a day of it?",
            "I'll bring coffee.",
            "Robin",
        ],
    },
];

pub fn message(index: usize) -> &'static Message {
    &MESSAGES[index % MESSAGES.len()]
}
