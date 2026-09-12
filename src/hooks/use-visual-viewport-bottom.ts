import * as React from "react";

/**
 * Pixels the on-screen keyboard (or browser chrome) eats from the layout
 * viewport bottom. Use as `style={{ bottom: inset }}` on fixed bottom UI so
 * submit controls stay in the visual viewport.
 */
export function useVisualViewportBottomInset() {
	const [inset, setInset] = React.useState(0);

	React.useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const update = () => {
			const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
			setInset(gap);
		};

		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, []);

	return inset;
}
