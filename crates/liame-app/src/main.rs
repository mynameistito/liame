//! Native shell. The demo mailbox is explicitly synthetic; no profile is opened.
mod demo;

use gpui::{
    App, Application, Bounds, Context, FocusHandle, FontWeight, KeyBinding, ScrollStrategy,
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
        let message = demo::message(self.selected);
        div()
            .size_full()
            .flex()
            .overflow_hidden()
            .bg(rgb(0x09090b))
            .text_color(rgb(0xe9e9ed))
            .text_size(px(13.))
            .font_family(if cfg!(target_os = "windows") {
                "Segoe UI"
            } else {
                "sans-serif"
            })
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::next))
            .on_action(cx.listener(Self::previous))
            .on_action(|_: &Quit, _, cx| cx.quit())
            .child(
                div()
                    .w(px(208.))
                    .flex_shrink_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .border_r_1()
                    .border_color(rgb(0x232326))
                    .bg(rgb(0x101012))
                    .child(
                        div().h(px(68.)).px_5().flex().items_center().child(
                            div()
                                .text_size(px(19.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("liame"),
                        ),
                    )
                    .child(
                        div().px_3().child(
                            div()
                                .h(px(36.))
                                .px_3()
                                .rounded_md()
                                .flex()
                                .items_center()
                                .justify_between()
                                .bg(rgb(0x23252b))
                                .child("Inbox")
                                .child(
                                    div()
                                        .text_color(rgb(0xa9aab2))
                                        .text_size(px(11.))
                                        .child("10,000"),
                                ),
                        ),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .p_5()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(div().text_color(rgb(0xb5b7bf)).child("Demo mailbox"))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(0x85858f))
                                    .child("Native preview · no account connected"),
                            ),
                    ),
            )
            .child(
                div()
                    .w(px(354.))
                    .flex_shrink_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .border_r_1()
                    .overflow_hidden()
                    .border_color(rgb(0x232326))
                    .child(
                        div()
                            .h(px(68.))
                            .flex_shrink_0()
                            .px_5()
                            .flex()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(rgb(0x232326))
                            .child(
                                div()
                                    .text_size(px(17.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Inbox"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(0x85858f))
                                    .child("All messages"),
                            ),
                    )
                    .child(
                        uniform_list(
                            "messages",
                            Self::MESSAGE_COUNT,
                            cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                                range
                                    .map(|index| {
                                        let message = demo::message(index);
                                        div()
                                            .id(index)
                                            .w_full()
                                            .h(px(98.))
                                            .px_5()
                                            .py_4()
                                            .flex()
                                            .flex_col()
                                            .gap(px(5.))
                                            .border_b_1()
                                            .border_color(rgb(0x1a1a1e))
                                            .bg(rgb(if this.selected == index {
                                                0x1d2433
                                            } else {
                                                0x0e0e10
                                            }))
                                            .cursor_pointer()
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.selected = index;
                                                cx.notify();
                                            }))
                                            .hover(|style| style.bg(rgb(0x202127)))
                                            .child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .justify_between()
                                                    .child(
                                                        div()
                                                            .font_weight(FontWeight::SEMIBOLD)
                                                            .child(message.sender),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_size(px(10.))
                                                            .text_color(rgb(0x989aa5))
                                                            .child(message.time),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .truncate()
                                                    .text_color(rgb(0xd2d3da))
                                                    .child(message.subject),
                                            )
                                            .child(
                                                div()
                                                    .truncate()
                                                    .text_size(px(12.))
                                                    .text_color(rgb(0x9395a1))
                                                    .child(message.preview),
                                            )
                                    })
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .track_scroll(self.scroll.clone())
                        .min_h_0()
                        .flex_1(),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(68.))
                            .flex_shrink_0()
                            .px_8()
                            .flex()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(rgb(0x232326))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(0x9395a1))
                                    .child("INBOX"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(0x9395a1))
                                    .child(format!("{} of 10,000", self.selected + 1)),
                            ),
                    )
                    .child(
                        div()
                            .id("reader")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p_8()
                            .flex()
                            .flex_col()
                            .gap_6()
                            .child(
                                div()
                                    .max_w(px(660.))
                                    .text_size(px(24.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(message.subject),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_3()
                                    .child(
                                        div()
                                            .size(px(36.))
                                            .flex_shrink_0()
                                            .rounded_full()
                                            .bg(rgb(0x252e3c))
                                            .text_color(rgb(0xb7c9e7))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(message.initials),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .flex()
                                            .flex_col()
                                            .gap_1()
                                            .child(
                                                div()
                                                    .flex()
                                                    .gap_2()
                                                    .child(
                                                        div()
                                                            .font_weight(FontWeight::SEMIBOLD)
                                                            .child(message.sender),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_color(rgb(0x9395a1))
                                                            .truncate()
                                                            .child(message.email),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(rgb(0x9395a1))
                                                    .child("To you"),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(rgb(0x9395a1))
                                            .child(message.time),
                                    ),
                            )
                            .child(div().h(px(1.)).bg(rgb(0x232326)))
                            .child(
                                div()
                                    .max_w(px(640.))
                                    .flex()
                                    .flex_col()
                                    .gap_5()
                                    .text_size(px(14.))
                                    .line_height(px(25.))
                                    .text_color(rgb(0xc6c7d0))
                                    .children(
                                        message
                                            .body
                                            .iter()
                                            .map(|paragraph| div().child(*paragraph)),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .px_8()
                            .py_3()
                            .border_t_1()
                            .border_color(rgb(0x232326))
                            .text_size(px(11.))
                            .text_color(rgb(0x9395a1))
                            .child("↑ ↓  Navigate messages     ·     Demo content"),
                    ),
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
                window.set_window_title("Liame — Native preview");
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
