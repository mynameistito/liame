//! Native shell. The demo mailbox is explicitly synthetic; no profile is opened.
use gpui::{
    App, Application, Bounds, Context, FocusHandle, KeyBinding, ScrollStrategy,
    UniformListScrollHandle, Window, WindowBounds, WindowOptions, actions, div, prelude::*, px,
    rgb, size, uniform_list,
};

actions!(liame, [NextMessage, PreviousMessage, Quit]);

struct Shell {
    focus: FocusHandle,
    selected: usize,
    scroll: UniformListScrollHandle,
}

impl Shell {
    const MESSAGE_COUNT: usize = 10_000;

    fn next(&mut self, _: &NextMessage, _: &mut Window, cx: &mut Context<Self>) {
        self.selected = (self.selected + 1).min(Self::MESSAGE_COUNT - 1);
        self.scroll
            .scroll_to_item(self.selected, ScrollStrategy::Top);
        cx.notify();
    }

    fn previous(&mut self, _: &PreviousMessage, _: &mut Window, cx: &mut Context<Self>) {
        self.selected = self.selected.saturating_sub(1);
        self.scroll
            .scroll_to_item(self.selected, ScrollStrategy::Top);
        cx.notify();
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .bg(rgb(0x101113))
            .text_color(rgb(0xe9e9ec))
            .font_family("Arial")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::next))
            .on_action(cx.listener(Self::previous))
            .on_action(|_: &Quit, _, cx| cx.quit())
            .child(
                div()
                    .w(px(210.))
                    .h_full()
                    .p_5()
                    .flex()
                    .flex_col()
                    .gap_4()
                    .border_r_1()
                    .border_color(rgb(0x2a2c30))
                    .child(div().text_xl().child("Liame"))
                    .child("Native preview")
                    .child(div().text_color(rgb(0x9dbaf5)).child("Synthetic Inbox"))
                    .child("10,000 fixture messages")
                    .child(div().text_sm().text_color(rgb(0x999ba4)).child(
                        "Development shell. Account setup and synchronization are not connected yet.",
                    )),
            )
            .child(
                div()
                    .w(px(340.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .border_r_1()
                    .border_color(rgb(0x2a2c30))
                    .child(div().p_4().child("Inbox · synthetic mail"))
                    .child(
                        uniform_list(
                            "messages",
                            Self::MESSAGE_COUNT,
                            cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                                range
                                    .map(|index| {
                                        div()
                                            .id(index)
                                            .h(px(76.))
                                            .p_3()
                                            .flex()
                                            .flex_col()
                                            .gap_1()
                                            .bg(rgb(if this.selected == index {
                                                0x26364e
                                            } else {
                                                0x151619
                                            }))
                                            .cursor_pointer()
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.selected = index;
                                                cx.notify();
                                            }))
                                            .child("Liame fixture sender")
                                            .child(format!("Synthetic message {}", index + 1))
                                    })
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .track_scroll(self.scroll.clone())
                        .flex_1(),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .p_8()
                    .flex()
                    .flex_col()
                    .gap_4()
                    .child(div().text_2xl().child(format!(
                        "Synthetic message {}",
                        self.selected + 1
                    )))
                    .child("From: fixture@example.invalid")
                    .child("To: preview@example.invalid")
                    .child("This message is generated locally to exercise the native reader layout.")
                    .child("Select a message with the mouse, or use j/k and the arrow keys.")
                    .child("No mail account, credential store or Electron profile is accessed."),
            )
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        cx.bind_keys([
            KeyBinding::new("j", NextMessage, None),
            KeyBinding::new("down", NextMessage, None),
            KeyBinding::new("k", PreviousMessage, None),
            KeyBinding::new("up", PreviousMessage, None),
            KeyBinding::new("ctrl-q", Quit, None),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        if let Err(error) = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |window, cx| {
                cx.new(|cx| {
                    let focus = cx.focus_handle();
                    focus.focus(window);
                    Shell {
                        focus,
                        selected: 0,
                        scroll: UniformListScrollHandle::new(),
                    }
                })
            },
        ) {
            eprintln!("Unable to open Liame window: {error}");
            cx.quit();
        }
        cx.activate(true);
    });
}
